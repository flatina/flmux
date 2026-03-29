import type {
  HostPushMessage,
  HostPushPayload,
  HostRpc,
  HostRpcMethod,
  HostRpcParams,
  HostRpcResult
} from "../../rpc/host-rpc";
import type { RendererPushMessage, RendererPushPayload, RendererRpcRequestHandlers } from "../../rpc/renderer-rpc";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_RPC_TIMEOUT_MS = 15_000;
const WS_RECONNECT_DELAY_MS = 1_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type WsMessage = {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  message?: unknown;
  params?: unknown;
  payload?: unknown;
  result?: unknown;
  error?: unknown;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: any) => void,
    options?: { once?: boolean }
  ): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
}

interface WsRpcDependencies {
  createWebSocket: (url: string) => WebSocketLike;
  getLocation: () => { protocol: string; host: string };
  setReconnectTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearReconnectTimer: (timer: TimerHandle) => void;
}

export interface WsRpcTransport {
  setRendererRpcHandlers: (handlers: RendererRpcRequestHandlers) => void;
  sendRendererRpcMessage: <Message extends RendererPushMessage>(
    message: Message,
    payload: RendererPushPayload<Message>
  ) => void;
  getHostRpc: () => HostRpc;
}

const DEFAULT_DEPENDENCIES: WsRpcDependencies = {
  createWebSocket: (url) => new WebSocket(url),
  getLocation: () => window.location,
  setReconnectTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearReconnectTimer: (timer) => clearTimeout(timer)
};

export function createWsRpcTransport(dependencies: Partial<WsRpcDependencies> = {}): WsRpcTransport {
  const resolvedDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies
  } satisfies WsRpcDependencies;

  let ws: WebSocketLike | null = null;
  let connectPromise: Promise<WebSocketLike> | null = null;
  let connectingSocket: WebSocketLike | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let requestId = 0;
  const pending = new Map<number, PendingRequest>();
  const messageListeners = new Map<string, Set<(payload: unknown) => void>>();
  let rendererHandlers: RendererRpcRequestHandlers = {};

  function getWsUrl(): string {
    const loc = resolvedDependencies.getLocation();
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
  }

  function ensureConnected(): Promise<WebSocketLike> {
    if (ws && ws.readyState === WS_OPEN) {
      return Promise.resolve(ws);
    }
    if (ws && ws.readyState === WS_CONNECTING && connectPromise) {
      return connectPromise;
    }

    if (reconnectTimer) {
      resolvedDependencies.clearReconnectTimer(reconnectTimer);
      reconnectTimer = null;
    }

    const socket = resolvedDependencies.createWebSocket(getWsUrl());
    ws = socket;
    attachSocketHandlers(socket);

    connectPromise = waitForOpen(socket)
      .then(() => {
        if (ws !== socket) {
          throw new Error("WebSocket was replaced before open");
        }
        resubscribeAll(socket);
        return socket;
      })
      .finally(() => {
        if (connectingSocket === socket) {
          connectingSocket = null;
          connectPromise = null;
        }
      });
    connectingSocket = socket;

    return connectPromise;
  }

  function attachSocketHandlers(socket: WebSocketLike): void {
    socket.addEventListener("message", (event) => handleSocketMessage(socket, event));
    socket.addEventListener("close", () => handleSocketClose(socket));
    socket.addEventListener("error", () => {
      // close drives reconnect/cleanup
    });
  }

  function handleSocketMessage(socket: WebSocketLike, event: { data: string }): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(event.data) as WsMessage;
    } catch {
      return;
    }

    if (msg.type === "response" && typeof msg.id === "number") {
      const pendingRequest = pending.get(msg.id);
      if (pendingRequest) {
        pending.delete(msg.id);
        if (msg.error) {
          pendingRequest.reject(new Error(String(msg.error)));
        } else {
          pendingRequest.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.type === "push" && typeof msg.message === "string") {
      const listeners = messageListeners.get(msg.message);
      if (listeners) {
        for (const handler of listeners) {
          handler(msg.payload);
        }
      }
      return;
    }

    if (msg.type === "request" && typeof msg.method === "string") {
      const handler = rendererHandlers[msg.method as keyof RendererRpcRequestHandlers];
      if (!handler) {
        return;
      }

      Promise.resolve((handler as (params: unknown) => unknown)(msg.params))
        .then((result) => {
          safeSend(socket, { type: "response", id: msg.id, result });
        })
        .catch((error) => {
          safeSend(socket, { type: "response", id: msg.id, error: String(error) });
        });
    }
  }

  function handleSocketClose(socket: WebSocketLike): void {
    if (ws !== socket) {
      return;
    }

    ws = null;
    connectingSocket = null;
    connectPromise = null;
    rejectPendingRequests(new Error("WebSocket closed"));
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (!hasActiveSubscriptions() || reconnectTimer) {
      return;
    }

    reconnectTimer = resolvedDependencies.setReconnectTimer(() => {
      reconnectTimer = null;
      void ensureConnected().catch(() => {});
    }, WS_RECONNECT_DELAY_MS);
  }

  function rejectPendingRequests(error: Error): void {
    for (const [, pendingRequest] of pending) {
      pendingRequest.reject(error);
    }
    pending.clear();
  }

  function hasActiveSubscriptions(): boolean {
    for (const listeners of messageListeners.values()) {
      if (listeners.size > 0) {
        return true;
      }
    }
    return false;
  }

  function resubscribeAll(socket: WebSocketLike): void {
    for (const [message, listeners] of messageListeners) {
      if (listeners.size === 0) {
        continue;
      }
      safeSend(socket, { type: "subscribe", message });
    }
  }

  function safeSend(socket: WebSocketLike, payload: unknown): boolean {
    if (socket.readyState !== WS_OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function waitForOpen(socket: WebSocketLike): Promise<void> {
    if (socket.readyState === WS_OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before open"));
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connect failed"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("close", onClose, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
  }

  function sendSubscribe(message: string): void {
    void ensureConnected()
      .then((socket) => {
        safeSend(socket, { type: "subscribe", message });
      })
      .catch(() => {
        // best effort
      });
  }

  const hostRpc: HostRpc = {
    async request<Method extends HostRpcMethod>(
      method: Method,
      params: HostRpcParams<Method>
    ): Promise<HostRpcResult<Method>> {
      const socket = await ensureConnected();
      const id = ++requestId;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`WS RPC timeout: ${method}`));
        }, WS_RPC_TIMEOUT_MS);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as HostRpcResult<Method>);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });

        if (!safeSend(socket, { type: "request", id, method, params: params ?? {} })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("WebSocket is not open"));
        }
      });
    },

    subscribe<Message extends HostPushMessage>(
      message: Message,
      handler: (payload: HostPushPayload<Message>) => void
    ): () => void {
      let listeners = messageListeners.get(message);
      if (!listeners) {
        listeners = new Set();
        messageListeners.set(message, listeners);
      }

      const listener = (payload: unknown) => handler(payload as HostPushPayload<Message>);
      listeners.add(listener);

      if (listeners.size === 1) {
        sendSubscribe(message);
      }

      return () => {
        const currentListeners = messageListeners.get(message);
        currentListeners?.delete(listener);
        if (currentListeners?.size === 0) {
          messageListeners.delete(message);
          if (reconnectTimer && !hasActiveSubscriptions()) {
            resolvedDependencies.clearReconnectTimer(reconnectTimer);
            reconnectTimer = null;
          }
        }
      };
    }
  };

  return {
    setRendererRpcHandlers(handlers: RendererRpcRequestHandlers): void {
      rendererHandlers = handlers;
    },

    sendRendererRpcMessage<Message extends RendererPushMessage>(
      message: Message,
      payload: RendererPushPayload<Message>
    ): void {
      void ensureConnected()
        .then((socket) => {
          safeSend(socket, { type: "message", message, payload });
        })
        .catch(() => {
          // best effort in web mode
        });
    },

    getHostRpc(): HostRpc {
      return hostRpc;
    }
  };
}

const defaultTransport = createWsRpcTransport();

export function setRendererRpcHandlers(handlers: RendererRpcRequestHandlers): void {
  defaultTransport.setRendererRpcHandlers(handlers);
}

export function sendRendererRpcMessage<Message extends RendererPushMessage>(
  message: Message,
  payload: RendererPushPayload<Message>
): void {
  defaultTransport.sendRendererRpcMessage(message, payload);
}

export function getHostRpc(): HostRpc {
  return defaultTransport.getHostRpc();
}
