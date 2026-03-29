import { describe, expect, test } from "bun:test";
import type { SessionId } from "../lib/ids";
import type { RpcEndpoint } from "../lib/rpc";
import { PtydClient } from "./client";
import type { PtydDaemonStatusResult } from "./control-plane";
import type { PtydLockEntry } from "./lock-file";

class FakeEventSocket {
  destroyed = false;
  private readonly handlers = {
    data: [] as Array<(chunk: Buffer | string) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>
  };

  on(event: "data" | "close" | "error", handler: (...args: any[]) => void): this {
    if (event === "data") {
      this.handlers.data.push(handler as (chunk: Buffer | string) => void);
    } else if (event === "close") {
      this.handlers.close.push(handler as () => void);
    } else {
      this.handlers.error.push(handler as (error: Error) => void);
    }
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }

  emitClose(): void {
    for (const handler of this.handlers.close) {
      handler();
    }
  }
}

class FakeReconnectTimers {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  readonly setTimer = (callback: () => void): ReturnType<typeof setTimeout> => {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return { id } as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    const id = (timer as { id?: number }).id;
    if (typeof id === "number") {
      this.callbacks.delete(id);
    }
  };

  get size(): number {
    return this.callbacks.size;
  }

  runAll(): void {
    const pending = Array.from(this.callbacks.values());
    this.callbacks.clear();
    for (const callback of pending) {
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

function createLockEntry(name: string): PtydLockEntry {
  return {
    daemonId: `daemon.${name}` as PtydLockEntry["daemonId"],
    sessionId: "test-session" as SessionId,
    pid: 100,
    controlIpcPath: `control-${name}`,
    eventsIpcPath: `events-${name}`,
    startedAt: `2026-03-28T00:00:0${name === "initial" ? "1" : "2"}Z`,
    protocolVersion: "4"
  };
}

function createDaemonStatus(lockEntry: PtydLockEntry): PtydDaemonStatusResult {
  return {
    ok: true,
    daemonId: lockEntry.daemonId,
    sessionId: lockEntry.sessionId,
    pid: lockEntry.pid,
    controlIpcPath: lockEntry.controlIpcPath,
    eventsIpcPath: lockEntry.eventsIpcPath,
    startedAt: lockEntry.startedAt,
    protocolVersion: lockEntry.protocolVersion,
    terminalCount: 0
  };
}

describe("PtydClient reconnect lifecycle", () => {
  test("coalesces concurrent reconnects from failed RPC calls", async () => {
    const timers = new FakeReconnectTimers();
    const sockets: FakeEventSocket[] = [];
    const initialLock = createLockEntry("initial");
    const reconnectedLock = createLockEntry("reconnected");
    let ensureStartedCount = 0;
    let daemonStatusFailures = 0;

    const client = await PtydClient.start(
      {
        sessionId: "test-session" as SessionId,
        pushTerminalEvent: () => {}
      },
      {
        ensureStarted: async () => {
          ensureStartedCount += 1;
          return ensureStartedCount === 1 ? initialLock : reconnectedLock;
        },
        callIpc: async <Result>(endpoint: RpcEndpoint, method: string) => {
          if (method === "terminal.list") {
            return { terminals: [] } as Result;
          }
          if (method === "daemon.status") {
            if (endpoint.ipcPath === initialLock.controlIpcPath && daemonStatusFailures < 2) {
              daemonStatusFailures += 1;
              throw new Error("broken control connection");
            }
            return createDaemonStatus(
              endpoint.ipcPath === reconnectedLock.controlIpcPath ? reconnectedLock : initialLock
            ) as Result;
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
        createEventSocket: () => {
          const socket = new FakeEventSocket();
          sockets.push(socket);
          return socket;
        },
        setReconnectTimer: timers.setTimer,
        clearReconnectTimer: timers.clearTimer
      }
    );

    const [left, right] = await Promise.all([client.getDaemonStatus(), client.getDaemonStatus()]);

    expect(left.controlIpcPath).toBe(reconnectedLock.controlIpcPath);
    expect(right.controlIpcPath).toBe(reconnectedLock.controlIpcPath);
    expect(ensureStartedCount).toBe(2);
    expect(sockets).toHaveLength(2);
  });

  test("ignores close events from replaced event sockets", async () => {
    const timers = new FakeReconnectTimers();
    const sockets: FakeEventSocket[] = [];
    const initialLock = createLockEntry("initial");
    const reconnectedLock = createLockEntry("reconnected");
    let ensureStartedCount = 0;

    const client = await PtydClient.start(
      {
        sessionId: "test-session" as SessionId,
        pushTerminalEvent: () => {}
      },
      {
        ensureStarted: async () => {
          ensureStartedCount += 1;
          return ensureStartedCount === 1 ? initialLock : reconnectedLock;
        },
        callIpc: async <Result>(endpoint: RpcEndpoint, method: string) => {
          if (method === "terminal.list") {
            return { terminals: [] } as Result;
          }
          if (method === "daemon.status") {
            if (endpoint.ipcPath === initialLock.controlIpcPath) {
              throw new Error("broken control connection");
            }
            return createDaemonStatus(reconnectedLock) as Result;
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
        createEventSocket: () => {
          const socket = new FakeEventSocket();
          sockets.push(socket);
          return socket;
        },
        setReconnectTimer: timers.setTimer,
        clearReconnectTimer: timers.clearTimer
      }
    );

    await client.getDaemonStatus();
    expect(ensureStartedCount).toBe(2);
    expect(sockets).toHaveLength(2);

    sockets[0]!.emitClose();
    expect(timers.size).toBe(0);

    timers.runAll();
    expect(ensureStartedCount).toBe(2);
  });

  test("does not reopen the event stream after dispose during reconnect", async () => {
    const timers = new FakeReconnectTimers();
    const sockets: FakeEventSocket[] = [];
    const initialLock = createLockEntry("initial");
    const reconnectedLock = createLockEntry("reconnected");
    const reconnectGate = createDeferred<PtydLockEntry>();
    let ensureStartedCount = 0;

    const client = await PtydClient.start(
      {
        sessionId: "test-session" as SessionId,
        pushTerminalEvent: () => {}
      },
      {
        ensureStarted: async () => {
          ensureStartedCount += 1;
          return ensureStartedCount === 1 ? initialLock : reconnectGate.promise;
        },
        callIpc: async <Result>(_endpoint: RpcEndpoint, method: string) => {
          if (method === "terminal.list") {
            return { terminals: [] } as Result;
          }
          if (method === "daemon.status") {
            throw new Error("broken control connection");
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
        createEventSocket: () => {
          const socket = new FakeEventSocket();
          sockets.push(socket);
          return socket;
        },
        setReconnectTimer: timers.setTimer,
        clearReconnectTimer: timers.clearTimer
      }
    );

    const pendingStatus = client.getDaemonStatus();
    await Promise.resolve();

    await client.dispose();
    reconnectGate.resolve(reconnectedLock);

    await expect(pendingStatus).rejects.toThrow("broken control connection");
    expect(ensureStartedCount).toBe(2);
    expect(sockets).toHaveLength(1);
  });
});
