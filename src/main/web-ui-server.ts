import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { ServerWebSocket } from "bun";
import type { HostPushMessage, HostPushPayload } from "../shared/host-rpc";
import type { RendererRpcMethod } from "../shared/renderer-rpc";
import { info } from "../shared/logger";

export interface WebUiServerOptions {
  host: string;
  port: number;
  viewsDir: string;
  handleHostRpc: (method: string, params: unknown) => Promise<unknown>;
  handleRendererRpc: (method: string, params: unknown, respond: (result: unknown) => void) => void;
}

interface WsData {
  subscriptions: Set<string>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf"
};

export interface WebUiServer {
  url: string;
  stop: () => void;
  pushMessage: <M extends HostPushMessage>(message: M, payload: HostPushPayload<M>) => void;
  /** Send a renderer RPC request to all connected web clients */
  requestRenderer: (method: RendererRpcMethod, params: unknown) => Promise<unknown>;
}

export function startWebUiServer(options: WebUiServerOptions): WebUiServer {
  const clients = new Set<ServerWebSocket<WsData>>();
  let rendererRequestId = 0;
  const rendererPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const server = Bun.serve<WsData>({
    hostname: options.host,
    port: options.port,

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: { subscriptions: new Set<string>() } });
        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }

      // Static files from views directory
      return serveStaticFile(url.pathname, options.viewsDir);
    },

    websocket: {
      open(ws) {
        clients.add(ws);
      },

      async message(ws, raw) {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));

          // Host RPC request from client
          if (msg.type === "request" && typeof msg.method === "string") {
            try {
              const result = await options.handleHostRpc(msg.method, msg.params);
              ws.send(JSON.stringify({ type: "response", id: msg.id, result }));
            } catch (err) {
              ws.send(JSON.stringify({ type: "response", id: msg.id, error: String(err) }));
            }
            return;
          }

          // Subscribe to push messages
          if (msg.type === "subscribe" && typeof msg.message === "string") {
            ws.data.subscriptions.add(msg.message);
            return;
          }

          // Response to renderer RPC request
          if (msg.type === "response" && typeof msg.id === "number") {
            const p = rendererPending.get(msg.id);
            if (p) {
              rendererPending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error));
              else p.resolve(msg.result);
            }
            return;
          }
        } catch {
          // ignore malformed messages
        }
      },

      close(ws) {
        clients.delete(ws);
      }
    }
  });

  const url = `http://${options.host}:${server.port}`;
  info("web", `UI server at ${url}`);

  return {
    url,
    stop: () => server.stop(),

    pushMessage<M extends HostPushMessage>(message: M, payload: HostPushPayload<M>) {
      const data = JSON.stringify({ type: "push", message, payload });
      for (const ws of clients) {
        if (ws.data.subscriptions.has(message)) {
          ws.send(data);
        }
      }
    },

    requestRenderer(method: RendererRpcMethod, params: unknown): Promise<unknown> {
      const id = ++rendererRequestId;
      const data = JSON.stringify({ type: "request", id, method, params });

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rendererPending.delete(id);
          reject(new Error(`Renderer RPC timeout: ${method}`));
        }, 15_000);

        rendererPending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); }
        });

        // Send to first connected client
        for (const ws of clients) {
          ws.send(data);
          return;
        }

        clearTimeout(timer);
        rendererPending.delete(id);
        reject(new Error("No web clients connected"));
      });
    }
  };
}

function serveStaticFile(pathname: string, viewsDir: string): Response {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = join(viewsDir, filePath);

  try {
    const content = readFileSync(fullPath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(new Uint8Array(content), { headers: { "Content-Type": contentType } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
