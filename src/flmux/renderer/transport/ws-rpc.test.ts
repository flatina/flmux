import { describe, expect, test } from "bun:test";
import { createWsRpcTransport, type WebSocketLike } from "./ws-rpc";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

type TimerHandle = ReturnType<typeof setTimeout>;

describe("ws-rpc transport", () => {
  test("reuses one connecting websocket for concurrent requests", async () => {
    const env = createFakeWsEnv();
    const transport = createWsRpcTransport(env.dependencies);
    const hostRpc = transport.getHostRpc();

    const leftPromise = hostRpc.request("window.minimize", undefined);
    const rightPromise = hostRpc.request("window.close", undefined);

    expect(env.sockets).toHaveLength(1);

    const socket = env.sockets[0]!;
    socket.open();
    await flushMicrotasks();

    const requests = socket.sentMessages.filter((message) => message.type === "request");
    expect(requests).toHaveLength(2);

    socket.emitMessage({ type: "response", id: requests[0]!.id, result: { ok: true } });
    socket.emitMessage({ type: "response", id: requests[1]!.id, result: { ok: true } });

    await expect(leftPromise).resolves.toEqual({ ok: true });
    await expect(rightPromise).resolves.toEqual({ ok: true });
  });

  test("resubscribes after reconnect when push listeners are active", async () => {
    const env = createFakeWsEnv();
    const transport = createWsRpcTransport(env.dependencies);
    const hostRpc = transport.getHostRpc();
    const subscribe = hostRpc.subscribe!;

    const unsubscribe = subscribe("terminal.event", () => {});
    expect(env.sockets).toHaveLength(1);

    const firstSocket = env.sockets[0]!;
    firstSocket.open();
    await flushMicrotasks();

    expect(firstSocket.sentMessages).toContainEqual({ type: "subscribe", message: "terminal.event" });

    firstSocket.close();
    expect(env.timers.size).toBe(1);

    env.timers.runAll();
    expect(env.sockets).toHaveLength(2);

    const secondSocket = env.sockets[1]!;
    secondSocket.open();
    await flushMicrotasks();

    expect(secondSocket.sentMessages).toContainEqual({ type: "subscribe", message: "terminal.event" });

    unsubscribe();
  });

  test("sends renderer RPC responses through the originating socket only", async () => {
    const env = createFakeWsEnv();
    const transport = createWsRpcTransport(env.dependencies);
    const deferred = createDeferred<{ ok: true }>();

    transport.setRendererRpcHandlers({
      "workspace.summary": async () => deferred.promise as never
    });

    const hostRpc = transport.getHostRpc();
    const subscribe = hostRpc.subscribe!;
    const unsubscribe = subscribe("terminal.event", () => {});
    const firstSocket = env.sockets[0]!;
    firstSocket.open();
    await flushMicrotasks();

    firstSocket.emitMessage({
      type: "request",
      id: 7,
      method: "workspace.summary",
      params: undefined
    });

    firstSocket.close();
    env.timers.runAll();

    const secondSocket = env.sockets[1]!;
    secondSocket.open();
    await flushMicrotasks();

    deferred.resolve({ ok: true });
    await flushMicrotasks();

    expect(
      secondSocket.sentMessages.find((message) => message.type === "response" && message.id === 7)
    ).toBeUndefined();

    unsubscribe();
  });
});

function createFakeWsEnv(): {
  sockets: FakeWebSocket[];
  timers: FakeTimers;
  dependencies: Parameters<typeof createWsRpcTransport>[0];
} {
  const sockets: FakeWebSocket[] = [];
  const timers = new FakeTimers();

  return {
    sockets,
    timers,
    dependencies: {
      createWebSocket() {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      getLocation() {
        return {
          protocol: "http:",
          host: "localhost:7777"
        };
      },
      setReconnectTimer: timers.setTimer,
      clearReconnectTimer: timers.clearTimer
    }
  };
}

class FakeWebSocket implements WebSocketLike {
  readyState = WS_CONNECTING;
  readonly sentMessages: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<{ listener: (event: any) => void; once: boolean }>>();

  send(data: string): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error("socket is not open");
    }
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: any) => void,
    options?: { once?: boolean }
  ): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push({ listener, once: options?.once === true });
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }
    this.listeners.set(
      type,
      handlers.filter((entry) => entry.listener !== listener)
    );
  }

  open(): void {
    this.readyState = WS_OPEN;
    this.dispatch("open", { type: "open" });
  }

  close(): void {
    this.readyState = WS_CLOSED;
    this.dispatch("close", { type: "close" });
  }

  emitMessage(message: unknown): void {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  private dispatch(type: "open" | "message" | "error" | "close", event: any): void {
    const handlers = [...(this.listeners.get(type) ?? [])];
    for (const handler of handlers) {
      handler.listener(event);
      if (handler.once) {
        this.removeEventListener(type, handler.listener);
      }
    }
  }
}

class FakeTimers {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  readonly setTimer = (callback: () => void): TimerHandle => {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return { id } as unknown as TimerHandle;
  };

  readonly clearTimer = (timer: TimerHandle): void => {
    const id = (timer as { id?: number }).id;
    if (typeof id === "number") {
      this.callbacks.delete(id);
    }
  };

  get size(): number {
    return this.callbacks.size;
  }

  runAll(): void {
    const callbacks = Array.from(this.callbacks.values());
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
