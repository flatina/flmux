import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { createConnection, createFrameTransport, type Connection } from "bunite-core/rpc";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput,
  FlmuxSessionSaveLayouts
} from "../shared/rendererBridge";
import paneSvg from "./assets/pane.svg" with { type: "text" };
import folderSvg from "./assets/folder.svg" with { type: "text" };
import type { ExtensionHttpRequest, ExtensionHttpResponse, ExtensionHttpReturn } from "@flmux/extension-api";
import type { DiscoveredLocalExtension } from "./localExtensions";
import type { ResolvedExtHttpRoute } from "./extHttpRoutes";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import type { FsUploader } from "./fsBackend";
import { ModelPathError } from "@flmux/core/shell";
import type { FlmuxAuthorizationContext, FlmuxWebModeAuthorizer } from "./webModeAuth";
import type { WebauthnAuthService } from "./auth/webauthnService";
import { renderLoginPage, renderEnrollPage } from "./auth/authPages";
import { readCookie } from "./auth/cookies";

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
// Global per-request body cap. Sized for upload chunks; JSON-RPC and webauthn
// (pre-auth) re-impose their own smaller bounds via readBoundedText so the
// raised ceiling doesn't widen their buffering surface.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

function parseTrustedProxies(raw: string | undefined): ReadonlySet<string> {
  if (raw)
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  return new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
}

// Per-IP request-rate limit key. Trust is derived from the socket origin, not a
// flag: X-Forwarded-For is honored only when the connection actually arrives from
// a trusted address (default loopback — flmux binds 127.0.0.1). Behind Tailscale
// Funnel, tailscaled proxies from loopback and sets a trustworthy XFF (the real
// client IP; client-forged XFF is dropped), so the real IP is used. Direct clients
// are keyed by their socket IP. A trusted-origin connection with no XFF returns ""
// → skipped, never bucketed under loopback (which would share one key across all
// clients = DoS). The `trustedProxies` option (comma list) overrides for a
// non-colocated proxy.
function rateLimitKey(
  request: Request,
  server: { requestIP(req: Request): { address: string } | null } | null,
  trustedProxies: ReadonlySet<string>
): string {
  const socketIP = server?.requestIP(request)?.address;
  if (!socketIP) return "";
  if (trustedProxies.has(socketIP)) {
    return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  }
  return socketIP;
}

// Per-user (not per-IP) so co-located clients behind one NAT (meeting room)
// don't share — and drain — a single bucket. null → caller falls back to IP.
function rateLimitUserKey(request: Request, authorizer: FlmuxWebModeAuthorizer): string | null {
  const token =
    readCookie(request.headers.get("cookie"), authorizer.cookieName) ??
    readBearerToken(request.headers.get("authorization")) ??
    "";
  if (!token) return null;
  const name = authorizer.authorize(token)?.user.name;
  return name ? `u:${name}` : null;
}

// ── Extension HTTP route surface (served at /api/ext/<extId><path>) ──
// flmux owns the security envelope (auth, CORS, header filtering, error
// scrubbing); the extension handler only computes a body.

const EXT_ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "content-language",
  "vary"
]);

interface ExtRouteDeps {
  authorizer?: FlmuxWebModeAuthorizer;
  isExtensionEnabled?(extId: string): boolean;
  canUseExtension?(userId: string, extId: string): boolean;
}

type ElysiaSet = { status?: number | string; headers?: unknown } & Record<string, unknown>;

async function serveExtRoute(
  route: ResolvedExtHttpRoute,
  request: Request,
  set: ElysiaSet,
  deps: ExtRouteDeps
): Promise<Response | string> {
  if (deps.isExtensionEnabled && !deps.isExtensionEnabled(route.extId)) {
    set.status = 404;
    return "Not Found";
  }
  let userId: string | null = null;
  if (route.auth === "session") {
    const auth = authorizeRequest(request, set, deps.authorizer);
    if (!auth.ok) return "Unauthorized";
    userId = auth.context?.user?.name ?? (deps.authorizer ? null : "local");
    if (deps.authorizer && deps.canUseExtension && (!userId || !deps.canUseExtension(userId, route.extId))) {
      set.status = 403;
      return "Forbidden";
    }
  }
  try {
    const request_ = buildExtHttpRequest(request, route.path);
    return finalizeExtHttpResponse(await route.handler({ dataDir: route.dataDir, userId, request: request_ }));
  } catch (err) {
    console.warn(`[flmux] ext route ${route.extId} ${route.method} ${route.path} threw:`, err);
    set.status = 500;
    return "Internal Server Error";
  }
}

function buildExtHttpRequest(request: Request, routePath: string): ExtensionHttpRequest {
  return {
    method: request.method.toUpperCase() === "POST" ? "POST" : "GET",
    path: routePath,
    query: new URL(request.url).searchParams,
    header(name) {
      const lower = name.toLowerCase();
      if (lower === "cookie" || lower === "authorization") return null;
      return request.headers.get(lower);
    },
    arrayBuffer: () => request.arrayBuffer(),
    text: () => request.text(),
    json: () => request.json()
  };
}

// Bare body → { body }; ext headers filtered to a safe allow-list (drops
// access-control-*/set-cookie/CSP); nosniff + restrictive CSP forced so a
// response can never be active same-origin content. ACAO is never emitted.
function finalizeExtHttpResponse(ret: ExtensionHttpReturn): Response {
  const r: ExtensionHttpResponse =
    typeof ret === "string" || ret instanceof Uint8Array || ret instanceof ArrayBuffer ? { body: ret } : ret;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.headers ?? {})) {
    const name = key.toLowerCase();
    if (!EXT_ALLOWED_RESPONSE_HEADERS.has(name)) continue;
    if (/[\r\n]/.test(value)) throw new Error("illegal header value");
    headers[name] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "text/plain; charset=utf-8";
  headers["x-content-type-options"] = "nosniff";
  headers["content-security-policy"] = "default-src 'none'";
  return new Response((r.body ?? "") as BodyInit, { status: r.status ?? 200, headers });
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
  appName?: string;
  /** Explicit listen port. Undefined → OS-assigned (current default). */
  port?: number;
  /** Public browser origin (behind Funnel) added to the CSRF allowlist. */
  publicOrigin?: string;
  /** Called on every accepted WS upgrade with a fresh bunite Connection and
   *  the auth context resolved at upgrade time. Web mode: context.user is
   *  set (auth gate already passed). Desktop mode: WS isn't used (preload). */
  onRpcConnection?(conn: Connection, authContext: FlmuxAuthorizationContext | null): void;
  /** Passkey auth service (web mode). Owns `/api/auth/*`, mints sessions, and
   *  tracks live `/rpc` connections by tokenId for logout/revoke close. */
  webauthn?: WebauthnAuthService;
  /** Extension-declared HTTP routes, resolved with their extId + dataDir. */
  extHttpRoutes?: ResolvedExtHttpRoute[];
  /** Request-time liveness for a route's extension (onInit failure disables it). */
  isExtensionEnabled?(extId: string): boolean;
  /** Web-mode per-user entitlement for an extension (mirrors cap serving). */
  canUseExtension?(userId: string, extId: string): boolean;
  rateLimit?: { max: number; windowMs: number };
  /** WS keepalive: periodic server→client ping keeps idle connections alive under
   * a reverse proxy's idle timeout; idleTimeout is the dead-peer backstop. */
  wsKeepalive?: { pingIntervalMs: number; idleTimeoutSeconds: number };
  /** Comma list of trusted proxy socket IPs (see rateLimitKey); default loopback. */
  trustedProxies?: string;
  /** Per-user streaming-upload writer for `/api/fs/upload` (web only; null in
   * desktop / when the user has no fs policy). Reuses the `/fs` write boundary. */
  resolveFsUploader?(context: FlmuxAuthorizationContext | null): FsUploader | null;
  /** Per-file upload size limit (bytes). */
  maxUploadBytes?: number;
}): FlmuxServerHandle {
  const hostname = "127.0.0.1";
  const appName = options.appName ?? "flmux";
  const rateLimitConfig = options.rateLimit ?? { max: 600, windowMs: 60_000 };
  const wsKeepalive = options.wsKeepalive ?? { pingIntervalMs: 25_000, idleTimeoutSeconds: 120 };
  const trustedProxies = parseTrustedProxies(options.trustedProxies);
  const app = new Elysia({
    websocket: { maxPayloadLength: WS_MAX_PAYLOAD_BYTES, idleTimeout: wsKeepalive.idleTimeoutSeconds }
  })
    // generator runs before skip (skip takes 2 params): an unresolvable "" key
    // is produced then skipped, never bucketed shared. Desktop (no authorizer) skips.
    .use(
      rateLimit({
        scoping: "global",
        duration: rateLimitConfig.windowMs,
        max: rateLimitConfig.max,
        generator: (request, server) => {
          const userKey = options.authorizer ? rateLimitUserKey(request, options.authorizer) : null;
          return userKey ?? rateLimitKey(request, server, trustedProxies);
        },
        // Exempt the upload route ONLY for authenticated requests (user key
        // `u:<name>`): a folder upload is many chunk requests that would trip the
        // shared limiter, but it's per-file byte-capped. Unauthenticated upload
        // requests keep their IP key and stay limited (no pre-auth flood).
        skip: (request, key) =>
          !options.authorizer || !key || (key.startsWith("u:") && new URL(request.url).pathname === "/api/fs/upload")
      })
    )
    .get("/health", () => ({ ok: true }))
    // Pre-auth carve-out: login/enroll pages + the passkey ceremony endpoints
    // are reachable WITHOUT a session (they exist to create one). Every other
    // route stays behind authorizeRequest via `.all("*")`.
    .get("/login", () => htmlPage(renderLoginPage(appName)))
    .get("/enroll", () => htmlPage(renderEnrollPage(appName)))
    .post("/api/auth/passkey/register/options", ({ request }) =>
      options.webauthn ? options.webauthn.handleRegisterOptions(request) : notFound()
    )
    .post("/api/auth/passkey/register/verify", ({ request }) =>
      options.webauthn ? options.webauthn.handleRegisterVerify(request) : notFound()
    )
    .post("/api/auth/passkey/authenticate/options", ({ request }) =>
      options.webauthn ? options.webauthn.handleAuthenticateOptions(request) : notFound()
    )
    .post("/api/auth/passkey/authenticate/verify", ({ request }) =>
      options.webauthn ? options.webauthn.handleAuthenticateVerify(request) : notFound()
    )
    .post("/api/auth/logout", ({ request }) => (options.webauthn ? options.webauthn.handleLogout(request) : notFound()))
    .get("/api/clients", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      const router = await options.resolveShellModelRouter(auth.context);
      return {
        ok: true,
        user: auth.context?.user?.name ?? null,
        clients: await router.listClients()
      };
    })
    // Self-edit profile. Behind authorizeRequest; the target user is taken
    // from the session context only — never a request param — so a user can
    // only edit their OWN display name. Desktop has no authorizer → 404.
    .post("/api/auth/profile", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }
      if (!options.authorizer || !auth.context) {
        return notFound();
      }
      const authorizer = options.authorizer;
      const userName = auth.context.user.name;
      return handleJsonRequest<{ displayName?: unknown }>(request, set, async (input) => {
        if (typeof input.displayName !== "string") {
          throw new Error("displayName is required");
        }
        const updated = authorizer.userStore.setDisplayName(userName, input.displayName);
        return { displayName: updated.displayName };
      });
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
    .get("/__flmux/assets/folder.svg", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }
      return new Response(folderSvg, { headers: { "content-type": "image/svg+xml" } });
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
    // Folder upload (web). Body streamed to disk via the per-user FsUploader
    // (reuses the `/fs` write boundary). A file is an ordered chunk sequence —
    // the global body cap bounds each chunk, not the file.
    .post("/api/fs/upload", async ({ request, set }) => {
      const ctx = beginUpload(request, set, options);
      if (!ctx.ok) return ctx.body;
      const uploadId = ctx.query.get("uploadId") ?? "";
      const offset = Number(ctx.query.get("offset") ?? "0");
      const overwrite = ctx.query.get("overwrite") === "1";
      const final = ctx.query.get("final") !== "0"; // last chunk commits; default single-shot
      if (!Number.isInteger(offset) || offset < 0) {
        set.status = 400;
        return { ok: false, error: "offset must be a non-negative integer" };
      }
      try {
        // Bun gives `request.body === null` for an empty body — a 0-byte file
        // (`.gitkeep` etc.) is a valid single empty chunk, not an error.
        const result = await ctx.uploader.upload(
          ctx.path,
          (request.body as AsyncIterable<Uint8Array>) ?? EMPTY_STREAM,
          {
            uploadId,
            offset,
            final,
            overwrite,
            maxBytes: options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
          }
        );
        return { ok: true, result };
      } catch (error) {
        return uploadError(set, error);
      }
    })
    .get("/__flmux/internal/start", ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return handleInternalStartPageRequest(request);
    });

  // Extension-declared HTTP routes: concrete paths registered before the
  // catch-all (so they win) and after the rate limiter (so they're limited).
  for (const route of options.extHttpRoutes ?? []) {
    const fullPath = `/api/ext/${route.extId}${route.path}`;
    if (route.method === "GET") {
      app.get(fullPath, ({ request, set }) => serveExtRoute(route, request, set, options));
    } else {
      app.post(fullPath, ({ request, set }) => serveExtRoute(route, request, set, options));
    }
  }

  app.all("*", ({ request, set }) => {
    const auth = authorizeRequest(request, set, options.authorizer);
    if (!auth.ok) {
      // Unauthenticated top-level navigation → login page (a human with no
      // session). Non-navigation (XHR/asset) keeps the 401 so callers see
      // the failure rather than an HTML body.
      if (options.webauthn && isNavigationRequest(request)) {
        set.status = 302;
        setHeader(set, "location", "/login");
        return "";
      }
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
    // Per-socket unregister fn for the tokenId→connection live registry.
    const wsToUntrack = new WeakMap<object, () => void>();
    // Per-socket keepalive ping timer (cleared on close).
    const wsToPing = new WeakMap<object, ReturnType<typeof setInterval>>();
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
        // Track by session tokenId so logout / external revoke can force-close
        // this live socket. Machine bearer / dev-auth-as tokenIds are tracked
        // too but simply never targeted by logout.
        if (options.webauthn && auth.context?.tokenId) {
          wsToUntrack.set(
            raw,
            options.webauthn.registerRpcConnection(auth.context.tokenId, () => {
              (raw as { close?(): void }).close?.();
            })
          );
        }
        onConn(conn, auth.context);
        const pingTimer = setInterval(() => {
          try {
            (raw as { ping?(): void }).ping?.();
          } catch {
            /* socket already gone */
          }
        }, wsKeepalive.pingIntervalMs);
        wsToPing.set(raw, pingTimer);
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
        wsToUntrack.get(raw)?.();
        wsToUntrack.delete(raw);
        const pingTimer = wsToPing.get(raw);
        if (pingTimer) {
          clearInterval(pingTimer);
          wsToPing.delete(raw);
        }
        if (conn) {
          try {
            conn.shutdown("ws_close");
          } catch {
            /* swallow */
          }
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

  const url = new URL(request.url);
  // Human `?token=` path retired: passkey sessions arrive via cookie, machines
  // via bearer header. No query-token fallback (browser WS uses the cookie).
  const cookieToken = readCookie(request.headers.get("cookie"), authorizer.cookieName);
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  const presentedToken = cookieToken ?? bearerToken ?? "";

  // `authorize("")` normally returns null; dev-auth-as mode makes it return
  // a synthetic context. The denial below still fires in the normal path.
  const context = authorizer.authorize(presentedToken);
  if (!context) {
    const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    console.warn(
      `[flmux] auth denied: ${request.method} ${url.pathname} ` +
        `(cookie=${Boolean(cookieToken)} bearer=${Boolean(bearerToken)}${fwd ? ` from=${fwd}` : ""})`
    );
    return denyUnauthorized(set);
  }

  // CSRF: cookie auth is ambient on cross-origin browser requests; bearer isn't.
  if (cookieToken && presentedToken === cookieToken && webAllowedOrigins) {
    const origin = request.headers.get("origin");
    if (origin && !webAllowedOrigins.has(origin)) {
      return denyUnauthorized(set);
    }
  }

  return { ok: true, context };
}

function denyUnauthorized(set: { status?: number | string; headers?: unknown } & Record<string, unknown>): AuthResult {
  set.status = 401;
  setHeader(set, "www-authenticate", 'Bearer realm="flmux-web"');
  return { ok: false };
}

const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per file

const EMPTY_STREAM: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} };

type UploadServerOptions = {
  authorizer?: FlmuxWebModeAuthorizer;
  resolveFsUploader?(context: FlmuxAuthorizationContext | null): FsUploader | null;
};

type UploadContext =
  | { ok: true; uploader: FsUploader; path: string; query: URLSearchParams }
  | { ok: false; body: unknown };

// Shared preamble for both /api/fs/upload verbs: auth, fs-write ACL (same gate
// as the `/fs/write` cap), uploader availability, and a `/`-rooted `path` query.
function beginUpload(
  request: Request,
  set: { status?: number | string; headers?: unknown } & Record<string, unknown>,
  options: UploadServerOptions
): UploadContext {
  const auth = authorizeRequest(request, set, options.authorizer);
  if (!auth.ok) return { ok: false, body: "Unauthorized" };
  const uploader = options.resolveFsUploader?.(auth.context) ?? null;
  if (!uploader) {
    set.status = 404;
    return { ok: false, body: "Not Found" };
  }
  const query = new URL(request.url).searchParams;
  const path = query.get("path") ?? "";
  if (!path.startsWith("/")) {
    set.status = 400;
    return { ok: false, body: { ok: false, error: "path must be a '/'-rooted virtual path" } };
  }
  try {
    assertPathAllowed("/fs/write", "call", auth.context, options.authorizer);
  } catch (error) {
    set.status = error instanceof FlmuxAuthzError ? error.status : 403;
    return { ok: false, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
  return { ok: true, uploader, path, query };
}

function uploadError(set: { status?: number | string }, error: unknown): { ok: false; error: string } {
  set.status = error instanceof ModelPathError ? uploadStatusForCode(error.code) : 500;
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function uploadStatusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "NOT_WRITABLE":
      return 403;
    case "ALREADY_EXISTS":
      return 409;
    case "INVALID_PATH":
    case "INVALID_VALUE":
      return 400;
    default:
      return 500;
  }
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

function readBearerToken(rawAuthorizationHeader: string | null) {
  if (!rawAuthorizationHeader) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(rawAuthorizationHeader.trim());
  return match ? match[1] : null;
}

function htmlPage(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Pre-auth pages must never be framed (clickjacking on the ceremony).
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY"
    }
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

// A top-level navigation (vs XHR/asset) — `Sec-Fetch-Mode: navigate` is the
// reliable signal; fall back to an Accept: text/html GET for older clients.
function isNavigationRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
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
    // Bounded read (not request.json()): the global body cap is raised for
    // uploads, so JSON-RPC re-imposes its own 1 MiB limit here.
    const body = JSON.parse(await readBoundedText(request, MAX_JSON_BODY_BYTES)) as T;
    return { ok: true, result: await handler(body) };
  } catch (error) {
    set.status = error instanceof FlmuxAuthzError ? error.status : 400;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Read request.body up to `max` bytes, rejecting (413) past it — used where the
// raised global body cap must not apply (the upload route streams unboundedly
// large; everything else stays small).
export async function readBoundedText(request: Request, max: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new FlmuxAuthzError("request body too large", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
