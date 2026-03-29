import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionId, TerminalRuntimeId } from "../lib/ids";
import { getPtydControlIpcPath, getPtydEventsIpcPath } from "../lib/ipc/ipc-paths";
import { createJsonLineParser } from "../lib/ipc/json-lines";
import { callJsonRpcIpc } from "../lib/ipc/json-rpc-ipc";
import type { RpcEndpoint } from "../lib/rpc";
import { resolveAppWorkingDirectory, resolvePtydLaunchCommand } from "../lib/runtime-paths";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../types/terminal";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydDaemonStatusResult,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult
} from "./control-plane";
import { type PtydLockEntry, PtydLockFile } from "./lock-file";

const PTYD_START_TIMEOUT_MS = 5_000;
const PTYD_PING_TIMEOUT_MS = 600;

export interface StartPtydClientOptions {
  sessionId: SessionId;
  pushTerminalEvent: (event: TerminalRuntimeEvent) => void;
}

type ReconnectTimer = ReturnType<typeof setTimeout>;
interface EventSocket {
  on(event: "data", handler: (chunk: Buffer | string) => void): EventSocket;
  on(event: "close", handler: () => void): EventSocket;
  on(event: "error", handler: (error: Error) => void): EventSocket;
  destroy(): void;
}

export interface PtydClientDependencies {
  ensureStarted: (sessionId: SessionId, lockFile: PtydLockFile) => Promise<PtydLockEntry>;
  callIpc: <Result>(endpoint: RpcEndpoint, method: string, params: unknown, timeoutMs?: number) => Promise<Result>;
  createEventSocket: (ipcPath: string) => EventSocket;
  setReconnectTimer: (callback: () => void, delayMs: number) => ReconnectTimer;
  clearReconnectTimer: (timer: ReconnectTimer) => void;
}

const DEFAULT_DEPENDENCIES: PtydClientDependencies = {
  ensureStarted: (sessionId, lockFile) => ensurePtydStarted(sessionId, lockFile),
  callIpc: callJsonRpcIpc,
  createEventSocket: (ipcPath) => createConnection(ipcPath),
  setReconnectTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearReconnectTimer: (timer) => clearTimeout(timer)
};

export class PtydClient {
  private readonly runtimes = new Map<TerminalRuntimeId, TerminalRuntimeSummary>();
  private readonly lockFile: PtydLockFile;
  private endpoint: RpcEndpoint;
  private eventsIpcPath: string;
  private eventSocket: EventSocket | null = null;
  private reconnectTimer: ReconnectTimer | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private disposed = false;

  private constructor(
    private readonly sessionId: SessionId,
    private readonly options: Omit<StartPtydClientOptions, "sessionId">,
    initialLockEntry: PtydLockEntry,
    lockFile: PtydLockFile,
    private readonly dependencies: PtydClientDependencies
  ) {
    this.lockFile = lockFile;
    this.endpoint = toRpcEndpoint(initialLockEntry);
    this.eventsIpcPath = initialLockEntry.eventsIpcPath;
  }

  static async start(
    options: StartPtydClientOptions,
    dependencies: Partial<PtydClientDependencies> = {}
  ): Promise<PtydClient> {
    const resolvedDependencies = {
      ...DEFAULT_DEPENDENCIES,
      ...dependencies
    } satisfies PtydClientDependencies;
    const lockFile = new PtydLockFile(options.sessionId);
    const lockEntry = await resolvedDependencies.ensureStarted(options.sessionId, lockFile);
    const client = new PtydClient(
      options.sessionId,
      {
        pushTerminalEvent: options.pushTerminalEvent
      },
      lockEntry,
      lockFile,
      resolvedDependencies
    );
    await client.refreshRuntimes();
    client.connectEventStream();
    return client;
  }

  list(): TerminalRuntimeSummary[] {
    return Array.from(this.runtimes.values(), (runtime) => ({ ...runtime }));
  }

  async createTerminal(params: PtydParams<"terminal.create">): Promise<PtydResult<"terminal.create">> {
    const result = await this.call("terminal.create", params);
    this.runtimes.set(result.terminal.runtimeId, result.terminal);
    return result;
  }

  async killTerminal(params: PtydParams<"terminal.kill">): Promise<PtydResult<"terminal.kill">> {
    const result = await this.call("terminal.kill", params);
    if (result.removed) {
      this.runtimes.delete(result.runtimeId);
    }
    return result;
  }

  async input(params: PtydParams<"terminal.input">): Promise<PtydResult<"terminal.input">> {
    return this.call("terminal.input", params);
  }

  async resize(params: PtydParams<"terminal.resize">): Promise<PtydResult<"terminal.resize">> {
    const result = await this.call("terminal.resize", params);
    if (result.terminal) {
      this.runtimes.set(result.terminal.runtimeId, result.terminal);
    }
    return result;
  }

  async history(params: PtydParams<"terminal.history">): Promise<PtydResult<"terminal.history">> {
    return this.call("terminal.history", params);
  }

  async stopDaemon(): Promise<void> {
    try {
      await this.dependencies.callIpc(this.endpoint, "daemon.stop", undefined);
    } catch {
      // best effort — daemon may already be gone
    }
  }

  async getDaemonStatus(): Promise<PtydDaemonStatusResult> {
    return this.call("daemon.status", undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      this.dependencies.clearReconnectTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.replaceEventSocket(null);
  }

  private async call<Method extends PtydMethod>(
    method: Method,
    params: PtydParams<Method>
  ): Promise<PtydResult<Method>> {
    try {
      return await this.callOnce(method, params);
    } catch (error) {
      if (this.disposed) {
        throw error;
      }

      await this.ensureConnected();
      if (this.disposed) {
        throw error;
      }
      return this.callOnce(method, params);
    }
  }

  private async refreshRuntimes(): Promise<void> {
    const result = await this.callOnce("terminal.list", undefined);
    this.runtimes.clear();
    for (const runtime of result.terminals) {
      this.runtimes.set(runtime.runtimeId, runtime);
    }
  }

  private callOnce<Method extends PtydMethod>(
    method: Method,
    params: PtydParams<Method>,
    timeoutMs?: number
  ): Promise<PtydResult<Method>> {
    return this.dependencies.callIpc<PtydResult<Method>>(this.endpoint, method, params, timeoutMs);
  }

  private connectEventStream(): void {
    if (this.disposed) {
      return;
    }

    const socket = this.dependencies.createEventSocket(this.eventsIpcPath);
    this.replaceEventSocket(socket);

    const parser = createJsonLineParser((message) => {
      this.handleEvent(message as TerminalRuntimeEvent);
    });

    socket.on("data", parser);
    socket.on("close", () => {
      if (this.eventSocket !== socket) {
        return;
      }

      this.eventSocket = null;
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  private handleEvent(event: TerminalRuntimeEvent): void {
    if (event.type === "state") {
      this.runtimes.set(event.runtime.runtimeId, event.runtime);
    } else if (event.type === "removed") {
      this.runtimes.delete(event.runtimeId);
    }

    this.options.pushTerminalEvent(event);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = this.dependencies.setReconnectTimer(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => {});
    }, 500);
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.reconnectTimer) {
      this.dependencies.clearReconnectTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.reconnectPromise = this.performReconnect().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private async performReconnect(): Promise<void> {
    const lockEntry = await this.dependencies.ensureStarted(this.sessionId, this.lockFile);
    if (this.disposed) {
      return;
    }

    this.endpoint = toRpcEndpoint(lockEntry);
    this.eventsIpcPath = lockEntry.eventsIpcPath;
    await this.refreshRuntimes();
    if (this.disposed) {
      return;
    }

    this.connectEventStream();
  }

  private replaceEventSocket(nextSocket: EventSocket | null): void {
    const previousSocket = this.eventSocket;
    this.eventSocket = nextSocket;
    previousSocket?.destroy();
  }
}

async function ensurePtydStarted(sessionId: SessionId, lockFile = new PtydLockFile(sessionId)): Promise<PtydLockEntry> {
  const controlIpcPath = getPtydControlIpcPath(sessionId);
  const eventsIpcPath = getPtydEventsIpcPath(sessionId);
  const existing = await lockFile.load();
  if (existing && (await isPtydReachable(existing))) {
    return existing;
  }

  const identified = await identifyPtyd(controlIpcPath);
  if (identified && identified.protocolVersion === PTYD_PROTOCOL_VERSION) {
    const recovered = toLockEntry(sessionId, identified, eventsIpcPath);
    await lockFile.write(recovered);
    return recovered;
  }

  if (existing) {
    await lockFile.clear();
  }

  const launch = resolvePtydLaunchCommand();
  spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      FLMUX_PTYD_MANAGED: "1",
      FLMUX_PTYD_SESSION_ID: sessionId,
      FLMUX_ROOT: resolveAppWorkingDirectory()
    }
  }).unref();

  const deadline = Date.now() + PTYD_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const nextLockEntry = await lockFile.load();
    if (
      nextLockEntry &&
      nextLockEntry.protocolVersion === PTYD_PROTOCOL_VERSION &&
      (await isPtydReachable(nextLockEntry))
    ) {
      return nextLockEntry;
    }

    const nextIdentify = await identifyPtyd(controlIpcPath);
    if (nextIdentify && nextIdentify.protocolVersion === PTYD_PROTOCOL_VERSION) {
      const recovered = toLockEntry(sessionId, nextIdentify, eventsIpcPath);
      await lockFile.write(recovered);
      return recovered;
    }

    await delay(100);
  }

  throw new Error("flmux ptyd did not become ready in time");
}

async function isPtydReachable(lockEntry: PtydLockEntry): Promise<boolean> {
  try {
    await callJsonRpcIpc(
      {
        ipcPath: lockEntry.controlIpcPath
      },
      "system.ping",
      undefined,
      PTYD_PING_TIMEOUT_MS
    );
    return true;
  } catch {
    return false;
  }
}

async function identifyPtyd(controlIpcPath: string): Promise<PtydIdentifyResult | null> {
  try {
    return await callJsonRpcIpc<PtydIdentifyResult>(
      {
        ipcPath: controlIpcPath
      },
      "system.identify",
      undefined,
      PTYD_PING_TIMEOUT_MS
    );
  } catch {
    return null;
  }
}

function toRpcEndpoint(lockEntry: PtydLockEntry): RpcEndpoint {
  return {
    ipcPath: lockEntry.controlIpcPath
  };
}

function toLockEntry(
  sessionId: SessionId,
  identify: PtydIdentifyResult,
  eventsIpcPath = getPtydEventsIpcPath(sessionId)
): PtydLockEntry {
  return {
    daemonId: identify.daemonId,
    sessionId,
    pid: identify.pid,
    controlIpcPath: identify.controlIpcPath,
    eventsIpcPath: identify.eventsIpcPath || eventsIpcPath,
    startedAt: identify.startedAt,
    protocolVersion: identify.protocolVersion
  };
}
