import { createServer, type Server, type Socket } from "node:net";
import { asPtyDaemonId, type PtyDaemonId, type TerminalRuntimeId } from "../shared/ids";
import { getPtydControlIpcPath, getPtydEventsIpcPath, normalizeWorkspaceRoot } from "../shared/ipc-paths";
import { cleanupIpcListenerPath, prepareIpcListenerPath } from "../shared/ipc-socket";
import { toJsonLine } from "../shared/json-lines";
import { startJsonRpcIpcServer } from "../shared/json-rpc-ipc";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult
} from "../shared/ptyd-control-plane";
import type { TerminalRuntimeEvent } from "../shared/rpc";
import { type PtydLockEntry, PtydLockFile } from "./ptyd-lock-file";
import { resolveAppWorkingDirectory } from "./runtime-paths";
import { TerminalRuntimeManager } from "./terminal-runtime-manager";

const MAX_HISTORY_BYTES = 200_000;

export async function runPtydDaemonProcess(): Promise<void> {
  const daemonId = asPtyDaemonId(crypto.randomUUID());
  const startedAt = new Date().toISOString();
  const defaultCwd = resolveAppWorkingDirectory();
  const workspaceRoot = normalizeWorkspaceRoot(defaultCwd);
  const controlIpcPath = getPtydControlIpcPath(defaultCwd);
  const eventsIpcPath = getPtydEventsIpcPath(defaultCwd);
  const lockFile = new PtydLockFile(defaultCwd);
  const subscribers = new Set<Socket>();
  const outputHistory = new Map<TerminalRuntimeId, string>();
  let shuttingDown = false;

  const terminalRuntimeManager = new TerminalRuntimeManager({
    defaultCwd,
    push: (_message, payload) => {
      handleTerminalEvent(payload as TerminalRuntimeEvent);
    }
  });

  const controlServer = await startJsonRpcIpcServer({
    ipcPath: controlIpcPath,
    invoke: async (method, params) => {
      return invokePtydMethod(method as PtydMethod, params as PtydParams<PtydMethod>, {
        daemonId,
        controlIpcPath,
        eventsIpcPath,
        startedAt,
        terminalRuntimeManager,
        outputHistory,
        shutdown
      });
    }
  });
  const eventsServer = await startEventStreamServer(eventsIpcPath, terminalRuntimeManager, subscribers);

  const lockEntry: PtydLockEntry = {
    daemonId,
    workspaceRoot,
    pid: process.pid,
    controlIpcPath,
    eventsIpcPath,
    startedAt,
    protocolVersion: PTYD_PROTOCOL_VERSION
  };

  await lockFile.write(lockEntry);

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("beforeExit", () => {
    void shutdown();
  });

  function handleTerminalEvent(event: TerminalRuntimeEvent): void {
    if (event.type === "output") {
      const existing = outputHistory.get(event.runtimeId) ?? "";
      const next = `${existing}${event.data}`;
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

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await lockFile.clearIfOwned({
      daemonId,
      pid: process.pid
    });
    await controlServer.stop();
    await stopEventStreamServer(eventsServer, eventsIpcPath, subscribers);
    terminalRuntimeManager.dispose();
  }
}

async function invokePtydMethod<Method extends PtydMethod>(
  method: Method,
  params: PtydParams<Method>,
  context: {
    daemonId: PtyDaemonId;
    controlIpcPath: string;
    eventsIpcPath: string;
    startedAt: string;
    terminalRuntimeManager: TerminalRuntimeManager;
    outputHistory: Map<TerminalRuntimeId, string>;
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
        controlIpcPath: context.controlIpcPath,
        eventsIpcPath: context.eventsIpcPath,
        startedAt: context.startedAt,
        protocolVersion: PTYD_PROTOCOL_VERSION
      };
      return result as PtydResult<Method>;
    }
    case "terminal.list":
      return {
        terminals: context.terminalRuntimeManager.list()
      } as PtydResult<Method>;
    case "terminal.create":
      return context.terminalRuntimeManager.createTerminal(
        params as PtydParams<"terminal.create">
      ) as PtydResult<Method>;
    case "terminal.kill":
      return context.terminalRuntimeManager.killTerminal(params as PtydParams<"terminal.kill">) as PtydResult<Method>;
    case "terminal.input":
      return context.terminalRuntimeManager.input(params as PtydParams<"terminal.input">) as PtydResult<Method>;
    case "terminal.resize":
      return context.terminalRuntimeManager.resize(params as PtydParams<"terminal.resize">) as PtydResult<Method>;
    case "terminal.history": {
      const historyParams = params as PtydParams<"terminal.history">;
      const data = context.outputHistory.get(historyParams.runtimeId) ?? "";
      return {
        runtimeId: historyParams.runtimeId,
        data: typeof historyParams.maxBytes === "number" ? data.slice(-historyParams.maxBytes) : data
      } as PtydResult<Method>;
    }
    case "daemon.stop":
      queueMicrotask(() => {
        void context.shutdown();
      });
      return { ok: true } as PtydResult<Method>;
  }
}

async function startEventStreamServer(
  ipcPath: string,
  terminalRuntimeManager: TerminalRuntimeManager,
  subscribers: Set<Socket>
): Promise<Server> {
  await prepareIpcListenerPath(ipcPath);

  const server = createServer((socket) => {
    subscribers.add(socket);
    socket.on("close", () => {
      subscribers.delete(socket);
    });
    socket.on("error", () => {
      subscribers.delete(socket);
      socket.destroy();
    });

    for (const runtime of terminalRuntimeManager.list()) {
      socket.write(toJsonLine({ type: "state", runtime } satisfies TerminalRuntimeEvent));
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

async function stopEventStreamServer(server: Server, ipcPath: string, subscribers: Set<Socket>): Promise<void> {
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
