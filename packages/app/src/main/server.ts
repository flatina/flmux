import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import type { FlmuxSessionSnapshot } from "../shared/session";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { isSessionSnapshot } from "./sessionStore";
import type { FlmuxShellModelRouter } from "./shellModelBridge";

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
  shellModelRouter: FlmuxShellModelRouter;
  localExtensions?: DiscoveredLocalExtension[];
  saveSession?(snapshot: FlmuxSessionSnapshot): Promise<void>;
  rpcWebHandler?: {
    open(ws: { send(data: Uint8Array | ArrayBuffer): void | number }): void;
    message(ws: { send(data: Uint8Array | ArrayBuffer): void | number }, raw: string | Buffer | ArrayBuffer | Uint8Array): void;
    close(ws: { send(data: Uint8Array | ArrayBuffer): void | number }): void;
  };
}): FlmuxServerHandle {
  const hostname = "127.0.0.1";
  const app = new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/api/clients", async () => ({
      ok: true,
      clients: await options.shellModelRouter.listClients()
    }))
    .get("/__flmux/runtime/extension-api.js", async ({ set }) =>
      await handleExtensionApiRuntimeModuleRequest("index.js", set)
    )
    .get("/__flmux/runtime/extension-api/:module", async ({ params, set }) =>
      await handleExtensionApiRuntimeModuleRequest(params.module, set)
    )
    .get("/__flmux/ext/:extensionId/:version/manifest.json", ({ params, set }) =>
      handleLocalExtensionManifestRequest(params, set, options.localExtensions ?? [])
    )
    .post("/api/model/path/get", async ({ request, set }) =>
      handleJsonRequest<ClientScopedPathGetInput>(request, set, (input) => options.shellModelRouter.pathGet(input))
    )
    .post("/api/model/path/list", async ({ request, set }) =>
      handleJsonRequest<ClientScopedPathListInput>(request, set, (input) => options.shellModelRouter.pathList(input))
    )
    .post("/api/model/path/set", async ({ request, set }) =>
      handleJsonRequest<ClientScopedPathSetInput>(request, set, (input) => options.shellModelRouter.pathSet(input))
    )
    .post("/api/model/path/call", async ({ request, set }) =>
      handleJsonRequest<ClientScopedPathCallInput>(request, set, (input) => options.shellModelRouter.pathCall(input))
    )
    .post("/api/session/save", async ({ request, set }) =>
      handleJsonRequest<FlmuxSessionSnapshot>(request, set, async (input) => {
        if (!options.saveSession) {
          throw new Error("Session persistence is not configured");
        }
        if (!isSessionSnapshot(input)) {
          throw new Error("Invalid flmux session snapshot");
        }

        await options.saveSession(input);
        return { ok: true };
      })
    )
    .get("/__flmux/internal/start", ({ request }) => handleInternalStartPageRequest(request))
    .all("*", ({ request, set }) => {
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
    set.status = 400;
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
