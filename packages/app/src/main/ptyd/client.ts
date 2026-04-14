import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TerminalRootStatus, TerminalRuntimeSummary } from "../../shared/terminal";
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

export class PtydClient {
  private readonly lockFile: PtydLockFile;
  private controlIpcPath: string;
  private eventsIpcPath: string;
  private ensureStartedPromise: Promise<PtydLockEntry> | null = null;
  private eventSocket: ReturnType<typeof createConnection> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly rootKey: string,
    readonly rootDir: string,
    private readonly onEvent?: (event: PtydTerminalEvent) => void
  ) {
    this.lockFile = new PtydLockFile(rootKey);
    this.controlIpcPath = getPtydControlIpcPath(rootKey);
    this.eventsIpcPath = getPtydEventsIpcPath(rootKey);
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
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }

    this.ensureStartedPromise = this.performEnsureStarted().finally(() => {
      this.ensureStartedPromise = null;
    });
    return this.ensureStartedPromise;
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

    const launch = resolvePtydLaunchCommand();
    launchPtydProcess(launch, {
      ...process.env,
      FLMUX_PTYD_ROOT_KEY: this.rootKey,
      FLMUX_PTYD_ROOT_DIR: this.rootDir
    });

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

    throw new Error(`flmux ptyd did not become ready for root ${this.rootKey}`);
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
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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

function resolvePtydLaunchCommand() {
  const cwd = process.cwd();
  if (isDevProcess() || isTestProcess()) {
    return {
      command: resolveBunCommand(),
      args: [resolve(cwd, "src", "main", "ptyd", "daemonMain.ts")],
      cwd
    };
  }

  const bundled = resolve(cwd, "dist", "ptyd.js");
  if (existsSync(bundled)) {
    return {
      command: resolveBunCommand(),
      args: [bundled],
      cwd
    };
  }

  return {
    command: resolveBunCommand(),
    args: [resolve(cwd, "src", "main", "ptyd", "daemonMain.ts")],
    cwd
  };
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}

function isDevProcess() {
  const argv = [...process.argv, ...Bun.argv];
  return (
    process.env.FLMUX_DEV_MODE === "1" ||
    argv.includes("--dev") ||
    argv.some((arg) => arg.endsWith("src/main.ts") || arg.endsWith("src\\main.ts"))
  );
}

function isTestProcess() {
  return [...process.argv, ...Bun.argv].some((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.js"));
}

function launchPtydProcess(
  launch: { command: string; args: string[]; cwd: string },
  env: Record<string, string | undefined>
) {
  if (process.platform === "win32" && !isDevProcess() && !isTestProcess()) {
    const powerShell = Bun.which("pwsh.exe") ?? Bun.which("pwsh") ?? Bun.which("powershell.exe") ?? Bun.which("powershell");
    if (powerShell) {
      const command = [
        "Start-Process",
        "-WindowStyle Hidden",
        `-FilePath ${quotePowerShell(launch.command)}`,
        `-ArgumentList @(${launch.args.map((arg) => quotePowerShell(arg)).join(", ")})`
      ].join(" ");

      spawn(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: launch.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env
      }).unref();
      return;
    }
  }

  spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  }).unref();
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
