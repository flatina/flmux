import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput,
  FlmuxSessionSaveLayouts,
  FlmuxShellBootstrapResponse
} from "../shared/rendererBridge";
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
  ".ico": "image/x-icon"
};

export interface FlmuxServerHandle {
  origin: string;
  stop(): void;
}

const EXTENSION_API_RUNTIME_DIST_DIR = fileURLToPath(new URL("../../../extension-api/dist-runtime/", import.meta.url));

export function startFlmuxServer(options: {
  rendererDir: string;
  /** Request-scoped router resolver. Desktop returns its single authority
   * router regardless of context; web returns the calling user's router
   * (auth context carries the user id; web mode guarantees non-null
   * context because auth would have already rejected the request). */
  resolveShellModelRouter(context: FlmuxAuthorizationContext | null): Promise<FlmuxShellModelRouter>;
  localExtensions?: DiscoveredLocalExtension[];
  /** Called from `/api/session/save` beacon. Receives the authenticated
   * user's context so web mode can route to the right per-user
   * authority; desktop ignores it and routes to its single authority.
   * Undefined when the calling authority has no sessionStore wired. */
  saveSession?(context: FlmuxAuthorizationContext | null, layouts: FlmuxSessionSaveLayouts): Promise<void>;
  /** Build the bootstrap snapshot for the authenticated user. When
   * `existingAttachmentId` is the cookie value from a prior bootstrap
   * and the server still owns that attachment for this user, the
   * callback may reuse it (B2 Phase 3 cookie continuity) — otherwise
   * it mints fresh. Only wired in web mode. */
  bootstrapAttachment?(
    context: FlmuxAuthorizationContext | null,
    existingAttachmentId: string | null
  ): Promise<FlmuxShellBootstrapResponse>;
  authorizer?: FlmuxWebModeAuthorizer;
  rpcWebHandler?: {
    open(ws: { send(data: Uint8Array | ArrayBuffer): void | number }): void;
    message(ws: { send(data: Uint8Array | ArrayBuffer): void | number }, raw: string | Buffer | ArrayBuffer | Uint8Array): void;
    close(ws: { send(data: Uint8Array | ArrayBuffer): void | number }): void;
  };
}): FlmuxServerHandle {
  const hostname = "127.0.0.1";
  const app = new Elysia()
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
    .get("/__flmux/runtime/extension-api.js", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return await handleExtensionApiRuntimeModuleRequest("index.js", set);
    })
    .get("/__flmux/runtime/extension-api/:module", async ({ request, params, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      return await handleExtensionApiRuntimeModuleRequest(params.module, set);
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
    .post("/api/shell/bootstrap", async ({ request, set }) => {
      const auth = authorizeRequest(request, set, options.authorizer);
      if (!auth.ok) {
        return "Unauthorized";
      }

      if (!options.bootstrapAttachment) {
        set.status = 404;
        return "Not Found";
      }

      // Per-user authority lazy-instantiation is an async step (B2 Phase 1)
      // — `getOrCreate(userId)` may spin up a fresh ShellCore + initialize
      // it. The seqStart/snapshot compose inside `authority.shellBootstrap`
      // is still sync (preflight #1 §S3) so the snapshot boundary invariant
      // holds. What's async is the user's authority creation, not the
      // bootstrap body.
      const existingAttachmentId = readCookie(request.headers.get("cookie"), "flmux-attachment");
      const response = await options.bootstrapAttachment(auth.context, existingAttachmentId);
      const cookie = `flmux-attachment=${response.attachmentId}; HttpOnly; Path=/; SameSite=Strict`;
      setHeader(set, "set-cookie", cookie);
      setHeader(set, "content-type", "application/json; charset=utf-8");
      return response;
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
      const extensionRuntimeResponse = maybeHandleLocalExtensionRuntimeRequest(pathname, set, options.localExtensions ?? []);
      if (extensionRuntimeResponse) {
        return extensionRuntimeResponse;
      }

      const resolved = resolveRendererPath(options.rendererDir, pathname);
      if (!resolved) {
        set.status = 404;
        return "Not Found";
      }

      const contentType = MIME_TYPES[extname(resolved)] ?? "application/octet-stream";
      return new Response(Bun.file(resolved), {
        headers: { "content-type": contentType }
      });
    });

  if (options.rpcWebHandler) {
    const rpcHandler = options.rpcWebHandler;
    app.ws("/rpc", {
      beforeHandle({ request, set }) {
        const auth = authorizeRequest(request, set, options.authorizer);
        if (!auth.ok) {
          return "Unauthorized";
        }
      },
      open(ws) { rpcHandler.open(ws.raw); },
      message(ws, message) { rpcHandler.message(ws.raw, message as string | Buffer); },
      close(ws) { rpcHandler.close(ws.raw); }
    });
  }

  app.listen({ hostname, port: 0 });
  const server = app.server;
  if (!server) {
    throw new Error("Elysia server failed to start");
  }

  return {
    origin: `http://${hostname}:${server.port}`,
    stop() {
      void app.stop(true);
    }
  };
}

type AuthResult =
  | { ok: true; context: FlmuxAuthorizationContext | null }
  | { ok: false };

function authorizeRequest(
  request: Request,
  set: { status?: number | string; headers?: unknown } & Record<string, unknown>,
  authorizer: FlmuxWebModeAuthorizer | undefined
): AuthResult {
  if (!authorizer) {
    return { ok: true, context: null };
  }

  const url = new URL(request.url);
  const cookieToken = readCookie(request.headers.get("cookie"), authorizer.cookieName);
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  const queryToken = url.searchParams.get(authorizer.queryParam);
  const presentedToken = cookieToken ?? bearerToken ?? queryToken ?? "";

  if (!presentedToken) {
    return denyUnauthorized(set);
  }

  const context = authorizer.authorize(presentedToken);
  if (!context) {
    return denyUnauthorized(set);
  }

  if (queryToken === presentedToken && cookieToken !== presentedToken) {
    setHeader(set, "set-cookie", serializeCookie(authorizer.cookieName, presentedToken));
  }

  return { ok: true, context };
}

function denyUnauthorized(
  set: { status?: number | string; headers?: unknown } & Record<string, unknown>
): AuthResult {
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
  throw new FlmuxAuthzError(
    `User '${context.user.name}' is not allowed to ${method} '${path}'`
  );
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

function setHeader(
  set: { headers?: unknown } & Record<string, unknown>,
  name: string,
  value: string
) {
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

function serializeCookie(name: string, value: string) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
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

  return new Response(Bun.file(extension.runtimeManifestPath), {
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
  const resolved = resolveLocalExtensionRuntimeFile(pathname, localExtensions);
  if (!resolved) {
    set.status = 404;
    return "Not Found";
  }

  const { extension, filePath } = resolved;
  const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";

  return new Response(Bun.file(filePath), {
    headers: { "content-type": contentType }
  });
}

function resolveLocalExtensionRuntimeFile(
  pathname: string,
  localExtensions: DiscoveredLocalExtension[]
) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 5) {
    return null;
  }

  const [, , extensionId, version, ...relativeParts] = parts;
  const extension = resolveLocalExtension({ extensionId, version }, localExtensions);
  if (!extension || relativeParts.length === 0) {
    return null;
  }

  const relativePath = relativeParts.join("/");
  const filePath = resolveExtensionRuntimePath(extension.runtimeRootDir, relativePath);
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  return {
    extension,
    relativePath,
    filePath
  };
}

function resolveExtensionRuntimePath(rootDir: string, relativePath: string) {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
    return null;
  }

  const normalizedRelativePath = normalize(relativePath);
  if (normalizedRelativePath.startsWith("..")) {
    return null;
  }

  const fullPath = join(rootDir, normalizedRelativePath);
  const normalizedRoot = normalize(rootDir).replace(/[\\/]+$/, "");
  const normalizedFullPath = normalize(fullPath);
  if (!normalizedFullPath.startsWith(normalizedRoot)) {
    return null;
  }

  return normalizedFullPath;
}

async function handleExtensionApiRuntimeModuleRequest(
  moduleName: string,
  set: { status?: number | string }
) {
  const builtPath = resolveExtensionApiRuntimeBuiltPath(moduleName);
  if (builtPath) {
    return new Response(Bun.file(builtPath), {
      headers: { "content-type": "application/javascript; charset=utf-8" }
    });
  }

  if (!/^[A-Za-z0-9_-]+\.js$/.test(moduleName)) {
    set.status = 404;
    return "Not Found";
  }

  if (!existsSync(EXTENSION_API_RUNTIME_DIST_DIR)) {
    set.status = 500;
    return "Missing built extension-api runtime. Run 'bun run build:extension-api-runtime'.";
  }

  set.status = 500;
  return `Missing built extension-api runtime module '${moduleName}'. Run 'bun run build:extension-api-runtime'.`;
}

function resolveExtensionApiRuntimeBuiltPath(moduleName: string) {
  if (!/^[A-Za-z0-9_-]+\.js$/.test(moduleName)) {
    return null;
  }

  const builtPath =
    moduleName === "index.js"
      ? join(EXTENSION_API_RUNTIME_DIST_DIR, "index.js")
      : join(EXTENSION_API_RUNTIME_DIST_DIR, moduleName);
  return existsSync(builtPath) ? builtPath : null;
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
      headers: { "content-type": "text/html; charset=utf-8" }
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
  if (candidate.innerLayouts === null || typeof candidate.innerLayouts !== "object" || Array.isArray(candidate.innerLayouts)) {
    return false;
  }
  return true;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
