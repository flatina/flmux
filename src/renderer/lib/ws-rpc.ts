import type {
  HostPushMessage,
  HostPushPayload,
  HostRpc,
  HostRpcMethod,
  HostRpcParams,
  HostRpcResult
} from "../../shared/host-rpc";
import type { RendererRpcRequestHandlers } from "../../shared/renderer-rpc";

let ws: WebSocket | null = null;
let requestId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
const messageListeners = new Map<string, Set<(payload: unknown) => void>>();
let rendererHandlers: RendererRpcRequestHandlers = {};

function getWsUrl(): string {
  const loc = window.location;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}

function ensureConnected(): WebSocket {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;

  ws = new WebSocket(getWsUrl());

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // RPC response
      if (msg.type === "response" && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
        return;
      }

      // Push message
      if (msg.type === "push" && typeof msg.message === "string") {
        const listeners = messageListeners.get(msg.message);
        if (listeners) {
          for (const handler of listeners) handler(msg.payload);
        }
        return;
      }

      // Renderer RPC request (from server)
      if (msg.type === "request" && typeof msg.method === "string") {
        const handler = rendererHandlers[msg.method as keyof RendererRpcRequestHandlers];
        if (handler) {
          Promise.resolve((handler as (params: unknown) => unknown)(msg.params))
            .then((result) => ws?.send(JSON.stringify({ type: "response", id: msg.id, result })))
            .catch((err) => ws?.send(JSON.stringify({ type: "response", id: msg.id, error: String(err) })));
        }
        return;
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    for (const [, p] of pending) p.reject(new Error("WebSocket closed"));
    pending.clear();
    ws = null;
    // Reconnect after delay
    setTimeout(() => ensureConnected(), 1000);
  };

  return ws;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connect failed")), { once: true });
  });
}

export function setRendererRpcHandlers(handlers: RendererRpcRequestHandlers): void {
  rendererHandlers = handlers;
}

export function getHostRpc(): HostRpc {
  return {
    async request<Method extends HostRpcMethod>(
      method: Method,
      params: HostRpcParams<Method>
    ): Promise<HostRpcResult<Method>> {
      const socket = ensureConnected();
      await waitForOpen(socket);

      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`WS RPC timeout: ${method}`));
        }, 15_000);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as HostRpcResult<Method>);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        });

        socket.send(JSON.stringify({ type: "request", id, method, params: params ?? {} }));
      });
    },
    subscribe<Message extends HostPushMessage>(
      message: Message,
      handler: (payload: HostPushPayload<Message>) => void
    ): () => void {
      if (!messageListeners.has(message)) messageListeners.set(message, new Set());
      const listener = (payload: unknown) => handler(payload as HostPushPayload<Message>);
      messageListeners.get(message)!.add(listener);

      // Tell server we want this push message
      const socket = ensureConnected();
      waitForOpen(socket).then(() => {
        socket.send(JSON.stringify({ type: "subscribe", message }));
      });

      return () => {
        messageListeners.get(message)?.delete(listener);
      };
    }
  };
}
