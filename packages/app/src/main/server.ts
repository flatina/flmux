import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Elysia } from "elysia";
import type { FlmuxSessionSnapshot } from "../shared/session";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";
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

export function startFlmuxServer(options: {
  rendererDir: string;
  shellModelRouter: FlmuxShellModelRouter;
  saveSession?(snapshot: FlmuxSessionSnapshot): Promise<void>;
  rpcWebHandler?: { message(ws: { send(data: Uint8Array): void | number }, raw: string | Buffer): void };
}): FlmuxServerHandle {
  const hostname = "127.0.0.1";
  const app = new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/api/clients", async () => ({
      ok: true,
      clients: await options.shellModelRouter.listClients()
    }))
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
    .get(
      "/fixtures/counter",
      () =>
        fixtureHtml(
          "Counter",
          `
      <p>Counter fixture running on local HTTP origin.</p>
      <button id="inc">count: 0</button>
      <script>
        const btn = document.getElementById('inc');
        let count = 0;
        btn.addEventListener('click', () => {
          count += 1;
          btn.textContent = 'count: ' + count;
        });
      </script>
    `
        )
    )
    .get(
      "/fixtures/list",
      () =>
        fixtureHtml(
          "List",
          `
      <ul>
        <li>alpha</li>
        <li>beta</li>
        <li>gamma</li>
      </ul>
    `
        )
    )
    .get(
      "/fixtures/form",
      () =>
        fixtureHtml(
          "Form",
          `
      <form style="display:grid;gap:12px;max-width:360px">
        <label>Project <input name="project" value="flmux"></label>
        <label>Mode
          <select name="mode">
            <option>desktop</option>
            <option>web</option>
          </select>
        </label>
        <button type="button">Submit</button>
      </form>
    `
        )
    )
    .all("*", ({ request, set }) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
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
      message(ws, message) {
        rpcHandler.message(ws.raw, message as string | Buffer);
      }
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

function fixtureHtml(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 24px; color: #e6eefc; background: #0f1726; font: 14px/1.5 system-ui, sans-serif; }
    button, input, select { font: inherit; }
    input, select { width: 100%; padding: 8px 10px; border: 1px solid #32445f; border-radius: 8px; background: #111c2d; color: inherit; }
    button { padding: 8px 12px; border: 1px solid #3f5e87; border-radius: 8px; background: #16263d; color: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" }
    }
  );
}
