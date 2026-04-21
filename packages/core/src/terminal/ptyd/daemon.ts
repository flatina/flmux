import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { getPtydControlIpcPath, getPtydEventsIpcPath } from "./ipcPaths";
import { toJsonLine } from "./jsonLines";
import { startJsonRpcIpcServer } from "./jsonRpcIpc";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydDaemonStatusResult,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult,
  type PtydTerminalEvent
} from "./controlPlane";
import { PtydLockFile, type PtydLockEntry } from "./lockFile";
import { TerminalRuntimeManager } from "./terminalRuntimeManager";

const MAX_HISTORY_BYTES = 200_000;

export async function runPtydDaemonProcess(): Promise<void> {
  const daemonId = randomUUID();
  const rootKey = requireEnv("FLMUX_PTYD_ROOT_KEY");
  const rootDir = requireEnv("FLMUX_PTYD_ROOT_DIR");
  const startedAt = new Date().toISOString();
  const controlIpcPath = getPtydControlIpcPath(rootKey);
  const eventsIpcPath = getPtydEventsIpcPath(rootKey);
  const lockFile = new PtydLockFile(rootDir);
  const subscribers = new Set<Socket>();
  const outputHistory = new Map<string, string>();
  let shuttingDown = false;

  const runtimeManager = new TerminalRuntimeManager(rootKey, rootDir, (event) => {
    handleTerminalEvent(event);
  });

  const controlServer = await startJsonRpcIpcServer({
    ipcPath: controlIpcPath,
    invoke(method, params) {
      return invokePtydMethod(method as PtydMethod, params as PtydParams<PtydMethod>, {
        daemonId,
        rootKey,
        rootDir,
        controlIpcPath,
        eventsIpcPath,
        startedAt,
        runtimeManager,
        outputHistory,
        shutdown
      });
    }
  });
  const eventsServer = await startEventStreamServer(eventsIpcPath, subscribers, runtimeManager);

  const lockEntry: PtydLockEntry = {
    daemonId,
    pid: process.pid,
    rootKey,
    rootDir,
    controlIpcPath,
    eventsIpcPath,
    startedAt,
    protocolVersion: PTYD_PROTOCOL_VERSION
  };
  await lockFile.write(lockEntry);

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  function handleTerminalEvent(event: PtydTerminalEvent) {
    if (event.type === "output") {
      const next = `${outputHistory.get(event.runtimeId) ?? ""}${event.data}`;
      outputHistory.set(event.runtimeId, next.slice(-MAX_HISTORY_BYTES));
    }
    if (event.type === "removed") {
      outputHistory.delete(event.runtimeId);
    }

    const payload = toJsonLine(event);
    for (const subscriber of subscribers) {
      try {
        subscriber.write(payload);
      } catch {
        subscriber.destroy();
        subscribers.delete(subscriber);
      }
    }
  }

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Watchdog: on Windows, `server.close()` can stall waiting for a
    // named-pipe peer that doesn't fully end its side, stranding the
    // daemon with its `try/finally` never reaching `process.exit`.
    // Force-exit after 2s no matter what.
    setTimeout(() => process.exit(0), 2_000);

    try {
      await lockFile.clearIfOwned({ daemonId, pid: process.pid });
      await controlServer.stop();
      await stopEventStreamServer(eventsServer, eventsIpcPath, subscribers);
      runtimeManager.dispose();
    } finally {
      process.exit(0);
    }
  }
}

async function invokePtydMethod<Method extends PtydMethod>(
  method: Method,
  params: PtydParams<Method>,
  context: {
    daemonId: string;
    rootKey: string;
    rootDir: string;
    controlIpcPath: string;
    eventsIpcPath: string;
    startedAt: string;
    runtimeManager: TerminalRuntimeManager;
    outputHistory: Map<string, string>;
    shutdown: () => Promise<void>;
  }
): Promise<PtydResult<Method>> {
  switch (method) {
    case "system.ping":
      return { pong: true } as PtydResult<Method>;

    case "system.identify": {
      const result: PtydIdentifyResult = {
        app: "flmux-ptyd",
        daemonId: context.daemonId,
        pid: process.pid,
        rootKey: context.rootKey,
        rootDir: context.rootDir,
        controlIpcPath: context.controlIpcPath,
        eventsIpcPath: context.eventsIpcPath,
        startedAt: context.startedAt,
        protocolVersion: PTYD_PROTOCOL_VERSION
      };
      return result as PtydResult<Method>;
    }

    case "terminal.list":
      return { terminals: context.runtimeManager.list() } as PtydResult<Method>;

    case "terminal.create":
      return context.runtimeManager.createTerminal(params as PtydParams<"terminal.create">) as PtydResult<Method>;

    case "terminal.input":
      return context.runtimeManager.input(params as PtydParams<"terminal.input">) as PtydResult<Method>;

    case "terminal.resize":
      return context.runtimeManager.resizeTerminal(params as PtydParams<"terminal.resize">) as PtydResult<Method>;

    case "terminal.history": {
      const input = params as PtydParams<"terminal.history">;
      const data = context.outputHistory.get(input.runtimeId) ?? "";
      return {
        ok: true,
        runtimeId: input.runtimeId,
        data: typeof input.maxBytes === "number" ? data.slice(-input.maxBytes) : data
      } as PtydResult<Method>;
    }

    case "terminal.kill":
      return context.runtimeManager.killTerminal(params as PtydParams<"terminal.kill">) as PtydResult<Method>;

    case "daemon.stop":
      queueMicrotask(() => {
        void context.shutdown();
      });
      return { ok: true } as PtydResult<Method>;

    case "daemon.status": {
      const result: PtydDaemonStatusResult = {
        ok: true,
        daemonId: context.daemonId,
        pid: process.pid,
        rootKey: context.rootKey,
        rootDir: context.rootDir,
        controlIpcPath: context.controlIpcPath,
        eventsIpcPath: context.eventsIpcPath,
        startedAt: context.startedAt,
        protocolVersion: PTYD_PROTOCOL_VERSION,
        terminalCount: context.runtimeManager.list().length
      };
      return result as PtydResult<Method>;
    }

    case "root.status":
      return {
        rootKey: context.rootKey,
        rootDir: context.rootDir,
        runtimeCount: context.runtimeManager.list().length,
        updatedAt: new Date().toISOString()
      } as PtydResult<Method>;

    default:
      throw new Error(`Unknown ptyd method: ${String(method)}`);
  }
}

async function startEventStreamServer(
  ipcPath: string,
  subscribers: Set<Socket>,
  runtimeManager: TerminalRuntimeManager
): Promise<Server> {
  await cleanupIpcListenerPath(ipcPath);
  const server = createServer((socket) => {
    subscribers.add(socket);
    socket.on("close", () => subscribers.delete(socket));
    socket.on("error", () => {
      subscribers.delete(socket);
      socket.destroy();
    });

    for (const runtime of runtimeManager.list()) {
      socket.write(toJsonLine({ type: "state", terminal: runtime } satisfies PtydTerminalEvent));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function stopEventStreamServer(server: Server, ipcPath: string, subscribers: Set<Socket>) {
  for (const subscriber of subscribers) {
    subscriber.destroy();
  }
  subscribers.clear();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await cleanupIpcListenerPath(ipcPath);
}

async function cleanupIpcListenerPath(ipcPath: string) {
  if (process.platform === "win32") {
    return;
  }

  try {
    await Bun.file(ipcPath).delete();
  } catch {}
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}
