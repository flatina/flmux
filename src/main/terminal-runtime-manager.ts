import { basename } from "node:path";
import { loadTerminalHooks } from "./terminal-env-config";
import { type IPty, spawn } from "bun-pty";
import type { HostPushMessage, HostPushPayload, HostRpcParams, HostRpcResult } from "../shared/host-rpc";
import type { SessionId, TerminalRuntimeId } from "../shared/ids";
import { getAppRpcIpcPath } from "../shared/ipc-paths";
import type { TerminalRuntimeSummary } from "../shared/rpc";

interface TerminalRuntimeRecord {
  summary: TerminalRuntimeSummary;
  pty: IPty | null;
}

interface TerminalRuntimeManagerOptions {
  defaultCwd: string;
  sessionId: SessionId;
  defaultShell?: string | null;
  push: <Message extends HostPushMessage>(message: Message, payload: HostPushPayload<Message>) => void;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export class TerminalRuntimeManager {
  private readonly defaultShell: string;
  private readonly runtimes = new Map<TerminalRuntimeId, TerminalRuntimeRecord>();

  constructor(private readonly options: TerminalRuntimeManagerOptions) {
    this.defaultShell = options.defaultShell ?? resolveDefaultShell();
  }

  list(): TerminalRuntimeSummary[] {
    return Array.from(this.runtimes.values(), (record) => ({ ...record.summary }));
  }

  get(runtimeId: TerminalRuntimeId): TerminalRuntimeSummary | null {
    return this.runtimes.has(runtimeId) ? { ...this.runtimes.get(runtimeId)!.summary } : null;
  }

  createTerminal(params: HostRpcParams<"terminal.create">): HostRpcResult<"terminal.create"> {
    const existing = this.runtimes.get(params.runtimeId);
    if (existing?.pty) {
      return {
        ok: true,
        created: false,
        terminal: { ...existing.summary }
      };
    }

    if (existing && !existing.pty) {
      this.runtimes.delete(params.runtimeId);
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

    const pty = spawn(shell, resolveShellArgs(shell), {
      cwd,
      cols,
      rows,
      name: resolveTerminalName(),
      env: createPtyEnv(wsRoot, this.options.sessionId, params.paneId ?? null)
    });

    const record: TerminalRuntimeRecord = {
      summary,
      pty
    };

    // Run init hooks after shell emits first output (prompt ready)
    const hooks = loadTerminalHooks(wsRoot);
    let hooksPending = hooks.init.length > 0;

    pty.onData((data) => {
      if (hooksPending) {
        hooksPending = false;
        for (const cmd of hooks.init) {
          pty.write(`${cmd}\r`);
        }
      }

      if (this.runtimes.get(params.runtimeId) !== record) {
        return;
      }

      this.options.push("terminal.event", {
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

  killTerminal(params: HostRpcParams<"terminal.kill">): HostRpcResult<"terminal.kill"> {
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

    this.options.push("terminal.event", {
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

  input(params: HostRpcParams<"terminal.input">): HostRpcResult<"terminal.input"> {
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

  resize(params: HostRpcParams<"terminal.resize">): HostRpcResult<"terminal.resize"> {
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
    this.options.push("terminal.event", {
      type: "state",
      runtime: { ...summary }
    });
  }
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

function createPtyEnv(workspaceRoot: string, sessionId: SessionId, paneId: string | null): Record<string, string> {
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
  if (paneId) {
    env.FLMUX_PANE_ID = paneId;
  }

  return env;
}
