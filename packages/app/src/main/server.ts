import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Elysia } from "elysia";
import { createConnection, createFrameTransport, type Connection } from "bunite-core/rpc";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput,
  FlmuxSessionSaveLayouts
} from "../shared/rendererBridge";
import paneSvg from "./assets/pane.svg" with { type: "text" };
import type { DiscoveredLocalExtension } from "./localExtensions";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import type { FlmuxAuthorizationContext, FlmuxWebModeAuthorizer } from "./webModeAuth";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm"
};

interface FlmuxServerHandle {
  origin: string;
  stop(): void;
}

// CSRF origin allowlist for cookie-auth requests; null = check off (desktop).
let webAllowedOrigins: ReadonlySet<string> | null = null;

const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const AUTH_WINDOW_MS = Number(process.env.FLMUX_AUTH_RATELIMIT_WINDOW_MS) || 60_000;
const AUTH_MAX_FAILURES = Number(process.env.FLMUX_AUTH_RATELIMIT_MAX_FAILURES) || 10;
const AUTH_LOCKOUT_MS = Number(process.env.FLMUX_AUTH_LOCKOUT_MS) || 300_000;

// Per-IP auth brute-force lockout. Key = a trusted proxy's resolved client IP
// only — client-supplied X-Forwarded-For is never trusted. Tailscale Funnel does
// NOT set XFF (tailscale/tailscale#12972); the real IP must come from a proxy
// that restored it via PROXY protocol (`funnel --proxy-protocol=2` → nginx/Caddy
// → XFF). Set FLMUX_TRUST_XFF=1 only when such a proxy is in front; otherwise the
// key is null and per-IP lockout is disabled — tokens are 256-bit so brute-force
// isn't viable regardless, and a shared fallback key would let one client lock
// everyone out (DoS).
const TRUST_XFF = process.env.FLMUX_TRUST_XFF === "1";
const authFailures = new Map<string, { times: number[]; lockedUntil: number }>();

function rateLimitKey(request: Request): string | null {
  if (!TRUST_XFF) return null;
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

function isLockedOut(key: string | null): boolean {
  if (key === null) return false;
  const e = authFailures.get(key);
  return e ? e.lockedUntil > Date.now() : false;
}

function recordAuthFailure(key: string | null): void {
  if (key === null) return;
  const now = Date.now();
  const e = authFailures.get(key) ?? { times: [], lockedUntil: 0 };
  e.times = e.times.filter((t) => now - t < AUTH_WINDOW_MS);
  e.times.push(now);
  if (e.times.length >= AUTH_MAX_FAILURES) {
    e.lockedUntil = now + AUTH_LOCKOUT_MS;
    e.times = [];
  }
  authFailures.set(key, e);
  if (authFailures.size > 10_000) pruneAuthFailures(now);
}

function pruneAuthFailures(now: number): void {
  for (const [k, e] of authFailures) {
    const last = e.times[e.times.length - 1];
    if (e.lockedUntil <= now && (last === undefined || now - last >= AUTH_WINDOW_MS)) {
      authFailures.delete(k);
    }
  }
}

export function startFlmuxServer(options: {
  rendererDir: string;
  /** Request-scoped router resolver. Desktop returns its single authority
   * router regardless of context; web returns the calling user's router
   * (auth context carries the user id; web mode guarantees non-null
   * context because auth would have already rejected the request). */
  resolveShellModelRouter(context: FlmuxAuthorizationContext | null): Promise<FlmuxShellModelRouter>;
  localExtensions?: DiscoveredLocalExtension[];
  /** Called from `/api/session/save` beacon — last-chance flush of layout
   *  state on page unload. cap RPC's pushLayout is the primary path. */
  saveSession?(context: FlmuxAuthorizationContext | null, layouts: FlmuxSessionSaveLayouts): Promise<void>;
  authorizer?: FlmuxWebModeAuthorizer;
  /** Explicit listen port. Undefined → OS-assigned (current default). */
  port?: number;
  /** Public browser origin (behind Funnel) added to the CSRF allowlist. */
  publicOrigin?: string;
  /** Called on every accepted WS upgrade with a fresh bunite Connection and
   *  the auth context resolved at upgrade time. Web mode: context.user is
   *  set (auth gate already passed). Desktop mode: WS isn't used (preload). */
  onRpcConnection?(conn: Connection, authContext: FlmuxAuthorizationContext | null): void;
}): FlmuxServerHandle {
  const hostname = "127.0.0.1";
  const app = new Elysia({ websocket: { maxPayloadLength: WS_MAX_PAYLOAD_BYTES } })
    .get("/health", () => ({ ok: true }))
    .get("/api/clients", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return {
        ok: true,
        clients: await router.listClients()
      };
    })
    // Shared static assets at /__flmux/assets/<file>. One route per asset
    // for now — keeps the surface trivial; if/when shared assets need
    // theme overlays (e.g. /__flmux/assets/theme/<file>), pivot to a
    // small dispatcher.
    .get("/__flmux/assets/pane.svg", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }
      return new Response(paneSvg, { headers: { "content-type": "image/svg+xml" } });
    })
    .get("/__flmux/ext/:extensionId/:version/manifest.json", ({ request, params, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return handleLocalExtensionManifestRequest(params, set, options.localExtensions ?? []);
    })
    .post("/api/model/path/get", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return handleJsonRequest<ClientScopedPathGetInput>(request, set, async (input) => {
        assertPathAllowed(input.path, "read", auth.context, options.authorizer);
        return await router.pathGet(input);
      });
    })
    .post("/api/model/path/list", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return handleJsonRequest<ClientScopedPathListInput>(request, set, async (input) => {
        assertPathAllowed(input.path, "read", auth.context, options.authorizer);
        return await router.pathList(input);
      });
    })
    .post("/api/model/path/set", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return handleJsonRequest<ClientScopedPathSetInput>(request, set, async (input) => {
        assertPathAllowed(input.path, "write", auth.context, options.authorizer);
        return await router.pathSet(input);
      });
    })
    .post("/api/model/path/call", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return handleJsonRequest<ClientScopedPathCallInput>(request, set, async (input) => {
        assertPathAllowed(input.path, "call", auth.context, options.authorizer);
        const deniedReason = checkPaneKindAuthz(input, auth.context, options.authorizer);
        if (deniedReason) {
          throw new FlmuxAuthzError(deniedReason);
        }
        return await router.pathCall(input);
      });
    })
    .post("/api/session/save", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return handleJsonRequest<FlmuxSessionSaveLayouts>(request, set, async (input) => {
        if (!options.saveSession) {
          throw new Error("Session persistence is not configured");
        }
        if (!isSessionSaveLayouts(input)) {
          throw new Error("Invalid flmux session save layouts");
        }

        await options.saveSession(auth.context, input);
        return { ok: true };
      });
    })
    .get("/__flmux/internal/start", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return handleInternalStartPageRequest(request);
    })
    .all("*", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const extensionRuntimeResponse = maybeHandleLocalExtensionRuntimeRequest(
        pathname,
        set,
        options.localExtensions ?? []
      );
      if (extensionRuntimeResponse) {
        return extensionRuntimeResponse;
      }

      const resolved = resolveRendererPath(options.rendererDir, pathname);
      if (!resolved) {
        set.status = 404;
        return "Not Found";
      }

      const contentType = MIME_TYPES[extname(resolved)] ?? "application/octet-stream";
      const headers: Record<string, string> = { "content-type": contentType };
      if (contentType.startsWith("text/html")) {
        // Workbench must never be framed by another origin (clickjacking).
        headers["content-security-policy"] = "frame-ancestors 'none'";
        headers["x-frame-options"] = "DENY";
      }
      return new Response(Bun.file(resolved), { headers });
    });

  if (options.onRpcConnection) {
    const onConn = options.onRpcConnection;
    const wsToReceive = new WeakMap<object, (bytes: Uint8Array) => void>();
    const wsToConn = new WeakMap<object, Connection>();
    app.ws("/rpc", {
      beforeHandle({ request, set }) {
        const auth = authorizeRequest(request, set, options.authorizer);
        if (!auth.ok) {
          return "Unauthorized";
        }
      },
      open(ws) {
        const raw = ws.raw as object;
        // Re-authorize at open time to capture the auth context — beforeHandle's
        // result isn't threaded to open in Elysia, but ws.data.request carries
        // the upgrade Request. Cheap (same parse path) and the only point
        // before onConn fires.
        const upgradeRequest = (ws.data as { request?: Request }).request;
        const auth = upgradeRequest
          ? authorizeRequest(upgradeRequest, { status: 0 }, options.authorizer)
          : { ok: true as const, context: null };
        if (!auth.ok) {
          (raw as { close?(): void }).close?.();
          return;
        }
        const pipe = {
          send: (bytes: Uint8Array) => {
            (raw as { send(data: Uint8Array | ArrayBuffer): unknown }).send(bytes);
          },
          setReceive: (h: (bytes: Uint8Array) => void) => {
            wsToReceive.set(raw, h);
          },
          close: () => {
            (raw as { close?(): void }).close?.();
          }
        };
        const conn = createConnection({
          transport: createFrameTransport(pipe),
          mode: "web",
          origin: new URL((ws as { url?: string }).url ?? "http://localhost").origin
        });
        wsToConn.set(raw, conn);
        onConn(conn, auth.context);
      },
      message(ws, message) {
        const recv = wsToReceive.get(ws.raw as object);
        if (!recv) return;
        if (typeof message === "string") {
          recv(new TextEncoder().encode(message));
        } else if (message instanceof Buffer) {
          recv(new Uint8Array(message));
        } else if (message instanceof ArrayBuffer) {
          recv(new Uint8Array(message));
        } else {
          recv(message as Uint8Array);
        }
      },
      close(ws) {
        const raw = ws.raw as object;
        const conn = wsToConn.get(raw);
        wsToConn.delete(raw);
        wsToReceive.delete(raw);
        if (conn) {
          try { conn.shutdown("ws_close"); } catch { /* swallow */ }
        }
      }
    });
  }

  app.listen({ hostname, port: options.port ?? 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  const server = app.server;
  if (!server) {
    throw new Error("Elysia server failed to start");
  }

  webAllowedOrigins = options.authorizer
    ? new Set(
        [`http://${hostname}:${server.port}`, `http://localhost:${server.port}`, options.publicOrigin].filter(
          (o): o is string => Boolean(o)
        )
      )
    : null;

  return {
    origin: `http://${hostname}:${server.port}`,
    stop() {
      void app.stop(true);
    }
  };
}

type AuthResult = { ok: true; context: FlmuxAuthorizationContext | null } | { ok: false };

function authorizeRequest(
  request: Request,
  set: { status?: number | string; headers?: unknown } & Record<string, unknown>,
  authorizer: FlmuxWebModeAuthorizer | undefined
): AuthResult {
  if (!authorizer) {
    return { ok: true, context: null };
  }

  const rlKey = rateLimitKey(request);
  if (isLockedOut(rlKey)) {
    set.status = 429;
    return { ok: false };
  }

  const url = new URL(request.url);
  const cookieToken = readCookie(request.headers.get("cookie"), authorizer.cookieName);
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  const queryToken = url.searchParams.get(authorizer.queryParam);
  const presentedToken = cookieToken ?? bearerToken ?? queryToken ?? "";

  // `authorize("")` normally returns null; dev-auth-as mode makes it return
  // a synthetic context. The denial below still fires in the normal path.
  const context = authorizer.authorize(presentedToken);
  if (!context) {
    const fwd = TRUST_XFF ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
    console.warn(
      `[flmux] auth denied: ${request.method} ${url.pathname} ` +
        `(cookie=${Boolean(cookieToken)} bearer=${Boolean(bearerToken)} query=${Boolean(queryToken)}` +
        `${fwd ? ` from=${fwd}` : ""})`
    );
    recordAuthFailure(rlKey);
    return denyUnauthorized(set);
  }

  // CSRF: cookie auth is ambient on cross-origin browser requests; bearer/query aren't.
  if (cookieToken && presentedToken === cookieToken && webAllowedOrigins) {
    const origin = request.headers.get("origin");
    if (origin && !webAllowedOrigins.has(origin)) {
      return denyUnauthorized(set);
    }
  }

  if (queryToken && queryToken === presentedToken && cookieToken !== presentedToken) {
    const fwdProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const secure = (fwdProto ?? url.protocol.replace(/:$/, "")) === "https";
    setHeader(set, "set-cookie", serializeCookie(authorizer.cookieName, presentedToken, secure));
  }

  if (rlKey) authFailures.delete(rlKey);
  return { ok: true, context };
}

function denyUnauthorized(set: { status?: number | string; headers?: unknown } & Record<string, unknown>): AuthResult {
  set.status = 401;
  setHeader(set, "www-authenticate", 'Bearer realm="flmux-web"');
  return { ok: false };
}

function assertPathAllowed(
  path: string,
  method: "read" | "write" | "call",
  context: FlmuxAuthorizationContext | null,
  authorizer: FlmuxWebModeAuthorizer | undefined
): void {
  // No authorizer = desktop mode (single trusted user), or test scaffold
  // without auth — skip. With auth set but no context, the request would
  // have been rejected earlier; defensive fall-through.
  if (!authorizer || !context) return;
  if (authorizer.isPathAllowed(context.user, method, path)) return;
  throw new FlmuxAuthzError(`User '${context.user.name}' is not allowed to ${method} '${path}'`);
}

function checkPaneKindAuthz(
  input: ClientScopedPathCallInput,
  context: FlmuxAuthorizationContext | null,
  authorizer: FlmuxWebModeAuthorizer | undefined
): string | null {
  if (!context || !authorizer) {
    return null;
  }

  if (input.path !== "/panes/new") {
    return null;
  }

  const kind = typeof input.args?.kind === "string" ? input.args.kind : null;
  if (!kind) {
    return null;
  }

  if (authorizer.isPaneKindAllowed(context.user, kind)) {
    return null;
  }

  return `User '${context.user.name}' is not allowed to create pane kind '${kind}'`;
}

function setHeader(set: { headers?: unknown } & Record<string, unknown>, name: string, value: string) {
  const current = isPlainHeaderRecord(set.headers) ? set.headers : {};
  set.headers = {
    ...current,
    [name]: value
  };
}

function isPlainHeaderRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCookie(rawCookieHeader: string | null, cookieName: string) {
  if (!rawCookieHeader) {
    return null;
  }

  for (const entry of rawCookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (rawName !== cookieName) {
      continue;
    }
    return decodeURIComponent(rawValue.join("="));
  }

  return null;
}

function readBearerToken(rawAuthorizationHeader: string | null) {
  if (!rawAuthorizationHeader) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(rawAuthorizationHeader.trim());
  return match ? match[1] : null;
}

function serializeCookie(name: string, value: string, secure: boolean) {
  // Secure only behind TLS (X-Forwarded-Proto: https from Funnel/proxy); omitted
  // on plain-http dev so the cookie reaches the insecure ws:// RPC handshake
  // (browsers withhold Secure cookies from non-secure connections).
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Strict`;
}

class FlmuxAuthzError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 403) {
    super(message);
    this.name = "FlmuxAuthzError";
    this.status = status;
  }
}

async function handleJsonRequest<T>(
  request: Request,
  set: { status?: number | string },
  handler: (input: T) => Promise<unknown>
) {
  try {
    const body = (await request.json()) as T;
    return {
      ok: true,
      result: await handler(body)
    };
  } catch (error) {
    set.status = error instanceof FlmuxAuthzError ? error.status : 400;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveRendererPath(rendererDir: string, pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = normalize(relative);
  if (normalized.startsWith("..")) {
    return null;
  }

  const fullPath = join(rendererDir, normalized);
  return existsSync(fullPath) ? fullPath : null;
}

function handleLocalExtensionManifestRequest(
  params: { extensionId: string; version: string },
  set: { status?: number | string },
  localExtensions: DiscoveredLocalExtension[]
) {
  const extension = resolveLocalExtension(params, localExtensions);
  if (!extension) {
    set.status = 404;
    return "Not Found";
  }

  // Serialize the already-validated runtime manifest rather than reading
  // from the backend again — works uniformly for source and archive origins.
  return new Response(JSON.stringify(extension.runtimeManifest), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function resolveLocalExtension(
  params: { extensionId: string; version: string },
  localExtensions: DiscoveredLocalExtension[]
) {
  const extensionId = params.extensionId;
  const version = params.version;
  return localExtensions.find((entry) => entry.id === extensionId && entry.version === version) ?? null;
}

function maybeHandleLocalExtensionRuntimeRequest(
  pathname: string,
  set: { status?: number | string },
  localExtensions: DiscoveredLocalExtension[]
) {
  if (!pathname.startsWith("/__flmux/ext/")) {
    return null;
  }

  return handleLocalExtensionRuntimeRequest(pathname, set, localExtensions);
}

function handleLocalExtensionRuntimeRequest(
  pathname: string,
  set: { status?: number | string },
  localExtensions: DiscoveredLocalExtension[]
) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 5) {
    set.status = 404;
    return "Not Found";
  }

  const [, , extensionId, version, ...relativeParts] = parts;
  const extension = resolveLocalExtension({ extensionId, version }, localExtensions);
  if (!extension || relativeParts.length === 0) {
    set.status = 404;
    return "Not Found";
  }

  const relativePath = relativeParts.join("/");
  const blob = extension.resolveRuntimeFile(relativePath);
  if (!blob) {
    set.status = 404;
    return "Not Found";
  }

  const contentType = MIME_TYPES[extname(relativePath)] ?? "application/octet-stream";
  return new Response(blob, {
    headers: { "content-type": contentType }
  });
}

function handleInternalStartPageRequest(request: Request): Response {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace");
  const workspaceLabel = workspaceId?.trim() || "current workspace";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>flmux Start</title>
  <style>
    body { margin: 0; padding: 24px; color: #e6eefc; background: #0f1726; font: 14px/1.5 system-ui, sans-serif; }
    main { display: grid; gap: 16px; max-width: 720px; }
    .badge { display: inline-block; padding: 4px 10px; border: 1px solid #3f5e87; border-radius: 999px; background: #16263d; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .card { padding: 16px; border: 1px solid #32445f; border-radius: 12px; background: #111c2d; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <span class="badge">Built-in Start Page</span>
    <section class="card">
      <h1>flmux browser pane</h1>
      <p>This is the default same-origin browser content for ${escapeHtml(workspaceLabel)}.</p>
      <p>Open a URL from the browser pane navigation field or create a browser pane with an explicit <code>url</code>.</p>
    </section>
  </main>
</body>
</html>`,
    {
      // Default browser-pane URL — must allow same-origin iframe (workbench) but not cross-origin.
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-ancestors 'self'",
        "x-frame-options": "SAMEORIGIN"
      }
    }
  );
}

function isSessionSaveLayouts(value: unknown): value is FlmuxSessionSaveLayouts {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!("outerLayout" in candidate) || !("innerLayouts" in candidate)) {
    return false;
  }
  if (
    candidate.innerLayouts === null ||
    typeof candidate.innerLayouts !== "object" ||
    Array.isArray(candidate.innerLayouts)
  ) {
    return false;
  }
  return true;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
