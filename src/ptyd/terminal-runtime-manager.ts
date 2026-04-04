import { basename, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { type IPty, spawn } from "bun-pty";
import { getAppRpcIpcPath } from "../lib/ipc/ipc-paths";
import type { SessionId, TerminalRuntimeId } from "../lib/ids";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../types/terminal";
import { loadTerminalHooks } from "./terminal-env-config";
import type { PtydParams, PtydResult } from "./control-plane";

interface TerminalRuntimeRecord {
  summary: TerminalRuntimeSummary;
  pty: IPty | null;
  startupQueue: string[] | null;
}

interface TerminalRuntimeManagerOptions {
  defaultCwd: string;
  sessionId: SessionId;
  defaultShell?: string | null;
  extraPath?: string[];
  spawnPty?: typeof spawn;
  pushTerminalEvent: (event: TerminalRuntimeEvent) => void;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export class TerminalRuntimeManager {
  private readonly defaultShell: string;
  private readonly spawnPty: typeof spawn;
  private readonly runtimes = new Map<TerminalRuntimeId, TerminalRuntimeRecord>();

  constructor(private readonly options: TerminalRuntimeManagerOptions) {
    this.defaultShell = options.defaultShell ?? resolveDefaultShell();
    this.spawnPty = options.spawnPty ?? spawn;
  }

  list(): TerminalRuntimeSummary[] {
    return Array.from(this.runtimes.values(), (record) => ({ ...record.summary }));
  }

  get(runtimeId: TerminalRuntimeId): TerminalRuntimeSummary | null {
    return this.runtimes.has(runtimeId) ? { ...this.runtimes.get(runtimeId)!.summary } : null;
  }

  createTerminal(params: PtydParams<"terminal.create">): PtydResult<"terminal.create"> {
    const existing = this.runtimes.get(params.runtimeId);
    if (existing) {
      return {
        ok: true,
        created: false,
        terminal: { ...existing.summary }
      };
    }

    const shell = params.shell?.trim() || this.defaultShell;
    const cwd = params.cwd ?? this.options.defaultCwd;
    const wsRoot = params.workspaceRoot ?? this.options.defaultCwd;
    const cols = params.cols ?? DEFAULT_COLS;
    const rows = params.rows ?? DEFAULT_ROWS;
    const summary: TerminalRuntimeSummary = {
      runtimeId: params.runtimeId,
      cwd,
      shell,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      cols,
      rows
    };

    const pty = this.spawnPty(shell, resolveShellArgs(shell), {
      cwd,
      cols,
      rows,
      name: resolveTerminalName(),
      env: createPtyEnv(wsRoot, this.options.sessionId, params.paneId ?? null, params.webPort ?? null, this.options.extraPath ?? [])
    });
    const startupQueue = buildStartupQueue(wsRoot, params.startupCommands);

    const record: TerminalRuntimeRecord = {
      summary,
      pty,
      startupQueue
    };

    pty.onData((data) => {
      if (record.startupQueue?.length) {
        const startupCommands = record.startupQueue;
        record.startupQueue = null;
        for (const cmd of startupCommands) {
          pty.write(`${cmd}\r`);
        }
      }

      if (this.runtimes.get(params.runtimeId) !== record) {
        return;
      }

      this.options.pushTerminalEvent({
        type: "output",
        runtimeId: params.runtimeId,
        data
      });
    });

    pty.onExit(({ exitCode }) => {
      const current = this.runtimes.get(params.runtimeId);
      if (current !== record) {
        return;
      }

      current.pty = null;
      current.summary = {
        ...current.summary,
        status: "exited",
        exitCode: exitCode ?? null
      };

      this.publishState(current.summary);
    });

    this.runtimes.set(params.runtimeId, record);
    this.publishState(summary);

    return {
      ok: true,
      created: true,
      terminal: { ...summary }
    };
  }

  killTerminal(params: PtydParams<"terminal.kill">): PtydResult<"terminal.kill"> {
    const record = this.runtimes.get(params.runtimeId);
    if (!record) {
      return {
        ok: true,
        runtimeId: params.runtimeId,
        removed: false,
        exitCode: null
      };
    }

    const exitCode = record.summary.exitCode;
    this.runtimes.delete(params.runtimeId);

    if (record.pty) {
      try {
        record.pty.kill();
      } catch {
        // best effort
      }
      record.pty = null;
    }

    this.options.pushTerminalEvent({
      type: "removed",
      runtimeId: params.runtimeId,
      exitCode
    });

    return {
      ok: true,
      runtimeId: params.runtimeId,
      removed: true,
      exitCode
    };
  }

  input(params: PtydParams<"terminal.input">): PtydResult<"terminal.input"> {
    const record = this.runtimes.get(params.runtimeId);
    if (!record?.pty) {
      return {
        ok: true,
        accepted: false
      };
    }

    record.pty.write(params.data);
    return {
      ok: true,
      accepted: true
    };
  }

  resize(params: PtydParams<"terminal.resize">): PtydResult<"terminal.resize"> {
    const record = this.runtimes.get(params.runtimeId);
    if (!record) {
      return {
        ok: true,
        terminal: null
      };
    }

    record.summary = {
      ...record.summary,
      cols: params.cols,
      rows: params.rows
    };

    if (record.pty) {
      try {
        record.pty.resize(params.cols, params.rows);
      } catch {
        // best effort
      }
    }

    this.publishState(record.summary);

    return {
      ok: true,
      terminal: { ...record.summary }
    };
  }

  dispose(): void {
    const runtimeIds = Array.from(this.runtimes.keys());
    for (const runtimeId of runtimeIds) {
      this.killTerminal({ runtimeId });
    }
  }

  private publishState(summary: TerminalRuntimeSummary): void {
    this.options.pushTerminalEvent({
      type: "state",
      runtime: { ...summary }
    });
  }
}

function buildStartupQueue(workspaceRoot: string, startupCommands: string[] | undefined): string[] | null {
  const hooks = loadTerminalHooks(workspaceRoot).init;
  const extra = (startupCommands ?? []).map((command) => command.trim()).filter((command) => command.length > 0);
  const queue = [...hooks, ...extra];
  return queue.length > 0 ? queue : null;
}

function resolveDefaultShell(): string {
  const fromEnv = process.env.FLMUX_SHELL?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (process.platform === "win32") {
    return (
      Bun.which("pwsh.exe") ??
      Bun.which("pwsh") ??
      Bun.which("powershell.exe") ??
      Bun.which("powershell") ??
      process.env.ComSpec ??
      "cmd.exe"
    );
  }

  return process.env.SHELL ?? Bun.which("bash") ?? "/bin/sh";
}

function resolveShellArgs(shell: string): string[] {
  const shellName = basename(shell).toLowerCase();
  if (process.platform === "win32") {
    if (shellName === "pwsh" || shellName === "pwsh.exe" || shellName === "powershell.exe") {
      return ["-NoLogo"];
    }
    return [];
  }

  if (shellName === "bash" || shellName === "zsh" || shellName === "fish") {
    return ["-i"];
  }

  return [];
}

function resolveTerminalName(): string {
  return process.platform === "win32" ? "xterm-color" : "xterm-256color";
}

function createPtyEnv(
  workspaceRoot: string,
  sessionId: SessionId,
  paneId: string | null,
  webPort: number | null,
  extraPath: string[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  const effectiveRoot = workspaceRoot || process.env.FLMUX_ROOT || process.cwd();
  env.TERM = process.platform === "win32" ? "xterm-color" : "xterm-256color";
  env.FLMUX_APP_IPC = getAppRpcIpcPath(sessionId);
  env.FLMUX_SESSION_ID = sessionId;
  env.FLMUX_ROOT = effectiveRoot;
  if (typeof webPort === "number" && Number.isFinite(webPort) && webPort > 0) {
    env.FLMUX_WEB_PORT = String(webPort);
  }
  if (paneId) {
    env.FLMUX_PANE_ID = paneId;
  }

  // Prepend extra paths (from [terminal].path config) to PATH.
  // Windows env keys are case-insensitive but JS objects are not — find the actual key.
  if (extraPath.length > 0) {
    const sep = process.platform === "win32" ? ";" : ":";
    const resolved = extraPath
      .map((p) => (isAbsolute(p) ? p : join(effectiveRoot, p)))
      .filter((p) => existsSync(p));
    if (resolved.length > 0) {
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
      env[pathKey] = resolved.join(sep) + sep + (env[pathKey] ?? "");
    }
  }

  return env;
}
