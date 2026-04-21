import { setTimeout as delay } from "node:timers/promises";
import type { TerminalRootStatus, TerminalRuntimeSummary } from "../terminal";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydTerminalEvent,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult
} from "./controlPlane";
import { getPtydControlIpcPath, getPtydEventsIpcPath } from "./ipcPaths";
import { createConnection } from "node:net";
import { createJsonLineParser } from "./jsonLines";
import { JsonRpcMethodError, callJsonRpcIpc } from "./jsonRpcIpc";
import { PtydLockFile, type PtydLockEntry } from "./lockFile";

const START_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 800;
const EVENT_RECONNECT_DELAY_MS = 500;

export interface PtydLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  launch(env: Record<string, string | undefined>): void | Promise<void>;
}

export interface PtydClientOptions {
  onEvent?: (event: PtydTerminalEvent) => void;
  launch?: () => PtydLaunchPlan;
}

export class PtydClient {
  private readonly lockFile: PtydLockFile;
  private controlIpcPath: string;
  private eventsIpcPath: string;
  private ensureStartedPromise: Promise<PtydLockEntry> | null = null;
  private eventSocket: ReturnType<typeof createConnection> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly onEvent?: (event: PtydTerminalEvent) => void;
  private readonly resolveLaunchPlan?: () => PtydLaunchPlan;

  constructor(
    readonly rootKey: string,
    readonly rootDir: string,
    onEventOrOptions?: ((event: PtydTerminalEvent) => void) | PtydClientOptions
  ) {
    const options =
      typeof onEventOrOptions === "function"
        ? { onEvent: onEventOrOptions }
        : (onEventOrOptions ?? {});
    this.lockFile = new PtydLockFile(rootKey);
    this.controlIpcPath = getPtydControlIpcPath(rootKey);
    this.eventsIpcPath = getPtydEventsIpcPath(rootKey);
    this.onEvent = options.onEvent;
    this.resolveLaunchPlan = options.launch;
  }

  async list() {
    const result = await this.call("terminal.list", undefined);
    return result.terminals;
  }

  async createTerminal(params: PtydParams<"terminal.create">) {
    return this.call("terminal.create", params, 10000);
  }

  async input(params: PtydParams<"terminal.input">) {
    return this.call("terminal.input", params, 5000);
  }

  async resize(params: PtydParams<"terminal.resize">) {
    return this.call("terminal.resize", params, 5000);
  }

  async history(params: PtydParams<"terminal.history">) {
    return this.call("terminal.history", params, 5000);
  }

  async killTerminal(params: PtydParams<"terminal.kill">) {
    return this.call("terminal.kill", params, 5000);
  }

  async getRootStatus(): Promise<TerminalRootStatus> {
    return this.call("root.status", undefined);
  }

  async getDaemonStatus() {
    return this.call("daemon.status", undefined);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.replaceEventSocket(null);
  }

  private async call<Method extends PtydMethod>(
    method: Method,
    params: PtydParams<Method>,
    timeoutMs?: number
  ): Promise<PtydResult<Method>> {
    try {
      return await this.callOnce(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof JsonRpcMethodError) {
        throw error;
      }

      await this.ensureStarted();
      return this.callOnce(method, params, timeoutMs);
    }
  }

  private callOnce<Method extends PtydMethod>(
    method: Method,
    params: PtydParams<Method>,
    timeoutMs?: number
  ) {
    return callJsonRpcIpc<PtydResult<Method>>(this.controlIpcPath, method, params, timeoutMs);
  }

  async ensureStarted() {
    if (this.disposed) {
      throw new Error(`PtydClient for root ${this.rootKey} is disposed`);
    }
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }

    this.ensureStartedPromise = this.performEnsureStarted().finally(() => {
      this.ensureStartedPromise = null;
    });
    return this.ensureStartedPromise;
  }

  /**
   * Attach to an existing reachable daemon without launching a new one.
   * Used by discovery paths (e.g. `listRoots`) that are query-only — they
   * must not have the side effect of spawning a daemon for a rootDir the
   * caller never asked about, which would leak processes if the lock file
   * is stale (daemon dead but file lingering from a prior session).
   * Returns `null` when no reachable daemon exists; also clears a stale
   * lock file along the way so it stops triggering discovery.
   */
  async connectIfRunning(): Promise<PtydLockEntry | null> {
    if (this.disposed) {
      throw new Error(`PtydClient for root ${this.rootKey} is disposed`);
    }

    const existing = await this.lockFile.load();
    if (existing && (await this.isReachable(existing.controlIpcPath))) {
      this.controlIpcPath = existing.controlIpcPath;
      this.eventsIpcPath = existing.eventsIpcPath;
      this.connectEventStream();
      return existing;
    }

    const identified = await this.identify(this.controlIpcPath);
    if (identified && identified.protocolVersion === PTYD_PROTOCOL_VERSION) {
      const recovered = this.toLockEntry(identified);
      await this.lockFile.write(recovered);
      this.controlIpcPath = recovered.controlIpcPath;
      this.eventsIpcPath = recovered.eventsIpcPath;
      this.connectEventStream();
      return recovered;
    }

    if (existing) {
      await this.lockFile.clear();
    }
    return null;
  }

  private async performEnsureStarted() {
    const existing = await this.lockFile.load();
    if (existing && (await this.isReachable(existing.controlIpcPath))) {
      this.controlIpcPath = existing.controlIpcPath;
      this.eventsIpcPath = existing.eventsIpcPath;
      this.connectEventStream();
      return existing;
    }

    const identified = await this.identify(this.controlIpcPath);
    if (identified && identified.protocolVersion === PTYD_PROTOCOL_VERSION) {
      const recovered = this.toLockEntry(identified);
      await this.lockFile.write(recovered);
      this.controlIpcPath = recovered.controlIpcPath;
      this.eventsIpcPath = recovered.eventsIpcPath;
      this.connectEventStream();
      return recovered;
    }

    if (existing) {
      await this.lockFile.clear();
    }

    const launch = this.resolveLaunchPlan?.();
    if (!launch) {
      throw new Error(`No ptyd launch plan configured for root ${this.rootKey}`);
    }

    try {
      await launch.launch({
        ...process.env,
        FLMUX_PTYD_ROOT_KEY: this.rootKey,
        FLMUX_PTYD_ROOT_DIR: this.rootDir
      });
    } catch (error) {
      throw new Error(
        `Failed to launch flmux ptyd for root ${this.rootKey}\n` +
        `  launch: ${formatLaunchPlan(launch)}\n` +
        `  error: ${String(error)}`
      );
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const next = await this.lockFile.load();
      if (next && next.protocolVersion === PTYD_PROTOCOL_VERSION && (await this.isReachable(next.controlIpcPath))) {
        this.controlIpcPath = next.controlIpcPath;
        this.eventsIpcPath = next.eventsIpcPath;
        this.connectEventStream();
        return next;
      }

      const nextIdentify = await this.identify(this.controlIpcPath);
      if (nextIdentify && nextIdentify.protocolVersion === PTYD_PROTOCOL_VERSION) {
        const recovered = this.toLockEntry(nextIdentify);
        await this.lockFile.write(recovered);
        this.controlIpcPath = recovered.controlIpcPath;
        this.eventsIpcPath = recovered.eventsIpcPath;
        this.connectEventStream();
        return recovered;
      }

      await delay(100);
    }

    throw new Error(
      `flmux ptyd did not become ready for root ${this.rootKey}\n` +
      `  launch: ${formatLaunchPlan(launch)}\n` +
      `  lockFile: ${JSON.stringify(await this.lockFile.load())}`
    );
  }

  private async isReachable(controlIpcPath: string) {
    try {
      await callJsonRpcIpc(controlIpcPath, "system.ping", undefined, PING_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async identify(controlIpcPath: string) {
    try {
      return await callJsonRpcIpc<PtydIdentifyResult>(
        controlIpcPath,
        "system.identify",
        undefined,
        PING_TIMEOUT_MS
      );
    } catch {
      return null;
    }
  }

  private toLockEntry(identify: PtydIdentifyResult): PtydLockEntry {
    return {
      daemonId: identify.daemonId,
      pid: identify.pid,
      rootKey: identify.rootKey,
      rootDir: identify.rootDir,
      controlIpcPath: identify.controlIpcPath,
      eventsIpcPath: identify.eventsIpcPath,
      startedAt: identify.startedAt,
      protocolVersion: identify.protocolVersion
    };
  }

  private connectEventStream() {
    if (this.eventSocket || !this.onEvent) {
      return;
    }

    const socket = createConnection(this.eventsIpcPath);
    this.replaceEventSocket(socket);
    const parser = createJsonLineParser((message) => {
      const event = message as PtydTerminalEvent;
      this.onEvent?.(event);
    });

    socket.on("data", parser);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      if (this.eventSocket === socket) {
        this.eventSocket = null;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.ensureStarted().catch(() => {
        this.scheduleReconnect();
      });
    }, EVENT_RECONNECT_DELAY_MS);
  }

  private replaceEventSocket(nextSocket: ReturnType<typeof createConnection> | null) {
    const previous = this.eventSocket;
    this.eventSocket = nextSocket;
    previous?.destroy();
  }
}

function formatLaunchPlan(launch: PtydLaunchPlan) {
  return `${launch.command} ${launch.args.join(" ")} (cwd=${launch.cwd})`;
}
