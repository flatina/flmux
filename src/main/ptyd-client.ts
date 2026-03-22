import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { HostPushMessage, HostPushPayload } from "../shared/host-rpc";
import type { TerminalRuntimeId } from "../shared/ids";
import { getPtydControlIpcPath, getPtydEventsIpcPath, normalizeWorkspaceRoot } from "../shared/ipc-paths";
import { createJsonLineParser } from "../shared/json-lines";
import { callJsonRpcIpc } from "../shared/json-rpc-ipc";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult
} from "../shared/ptyd-control-plane";
import type { RpcEndpoint, TerminalRuntimeEvent, TerminalRuntimeSummary } from "../shared/rpc";
import { type PtydLockEntry, PtydLockFile } from "./ptyd-lock-file";
import { resolveAppWorkingDirectory, resolvePtydLaunchCommand } from "./runtime-paths";

const PTYD_START_TIMEOUT_MS = 5_000;
const PTYD_PING_TIMEOUT_MS = 600;

export interface StartPtydClientOptions {
  push: <Message extends HostPushMessage>(message: Message, payload: HostPushPayload<Message>) => void;
}

export class PtydClient {
  private readonly runtimes = new Map<TerminalRuntimeId, TerminalRuntimeSummary>();
  private readonly lockFile = new PtydLockFile(resolveAppWorkingDirectory());
  private endpoint: RpcEndpoint;
  private eventsIpcPath: string;
  private eventSocket: Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private constructor(
    private lockEntry: PtydLockEntry,
    private readonly options: StartPtydClientOptions
  ) {
    this.endpoint = toRpcEndpoint(lockEntry);
    this.eventsIpcPath = lockEntry.eventsIpcPath;
  }

  static async start(options: StartPtydClientOptions): Promise<PtydClient> {
    const lockEntry = await ensurePtydStarted();
    const client = new PtydClient(lockEntry, options);
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
      await this.call("daemon.stop", undefined);
    } catch {
      // best effort — daemon may already be gone
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSocket?.destroy();
    this.eventSocket = null;
  }

  private async call<Method extends PtydMethod>(
    method: Method,
    params: PtydParams<Method>,
    attempt = 0
  ): Promise<PtydResult<Method>> {
    try {
      return await callJsonRpcIpc<PtydResult<Method>>(this.endpoint, method, params);
    } catch (error) {
      if (attempt > 0 || this.disposed) {
        throw error;
      }

      await this.reconnectToDaemon();
      return this.call(method, params, attempt + 1);
    }
  }

  private async refreshRuntimes(): Promise<void> {
    const result = await this.call("terminal.list", undefined);
    this.runtimes.clear();
    for (const runtime of result.terminals) {
      this.runtimes.set(runtime.runtimeId, runtime);
    }
  }

  private connectEventStream(): void {
    if (this.disposed) {
      return;
    }

    const socket = createConnection(this.eventsIpcPath);
    this.eventSocket = socket;

    const parser = createJsonLineParser((message) => {
      this.handleEvent(message as TerminalRuntimeEvent);
    });

    socket.on("data", parser);
    socket.on("close", () => {
      if (this.eventSocket === socket) {
        this.eventSocket = null;
      }

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

    this.options.push("terminal.event", event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectToDaemon();
    }, 500);
  }

  private async reconnectToDaemon(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.lockEntry = await ensurePtydStarted(this.lockFile);
    this.endpoint = toRpcEndpoint(this.lockEntry);
    this.eventsIpcPath = this.lockEntry.eventsIpcPath;
    await this.refreshRuntimes();
    this.eventSocket?.destroy();
    this.connectEventStream();
  }
}

async function ensurePtydStarted(lockFile = new PtydLockFile(resolveAppWorkingDirectory())): Promise<PtydLockEntry> {
  const workspaceRoot = resolveAppWorkingDirectory();
  const controlIpcPath = getPtydControlIpcPath(workspaceRoot);
  const eventsIpcPath = getPtydEventsIpcPath(workspaceRoot);
  const existing = await lockFile.load();
  if (existing && (await isPtydReachable(existing))) {
    return existing;
  }

  const identified = await identifyPtyd(controlIpcPath);
  if (identified && identified.protocolVersion === PTYD_PROTOCOL_VERSION) {
    const recovered = toLockEntry(workspaceRoot, identified, eventsIpcPath);
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
      FLMUX_ROOT: workspaceRoot
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
      const recovered = toLockEntry(workspaceRoot, nextIdentify, eventsIpcPath);
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
  workspaceRoot: string,
  identify: PtydIdentifyResult,
  eventsIpcPath = getPtydEventsIpcPath(workspaceRoot)
): PtydLockEntry {
  return {
    daemonId: identify.daemonId,
    workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
    pid: identify.pid,
    controlIpcPath: identify.controlIpcPath,
    eventsIpcPath: identify.eventsIpcPath || eventsIpcPath,
    startedAt: identify.startedAt,
    protocolVersion: identify.protocolVersion
  };
}
