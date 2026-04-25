import { spawn, type IPty } from "@flatina/bun-pty";
import { join, delimiter } from "node:path";
import type { TerminalRuntimeSummary } from "../types";
import type {
  PtydTerminalRecord,
  PtydTerminalCreateParams,
  PtydTerminalCreateResult,
  PtydTerminalEvent,
  PtydTerminalInputParams,
  PtydTerminalInputResult,
  PtydTerminalResizeParams,
  PtydTerminalResizeResult,
  PtydTerminalKillParams,
  PtydTerminalKillResult
} from "./controlPlane";

interface TerminalRuntimeRecord {
  ownerPaneId: string | null;
  summary: TerminalRuntimeSummary;
  pty: IPty | null;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export class TerminalRuntimeManager {
  private readonly runtimes = new Map<string, TerminalRuntimeRecord>();

  constructor(
    private readonly rootKey: string,
    private readonly rootDir: string,
    private readonly pushEvent: (event: PtydTerminalEvent) => void
  ) {}

  list() {
    return Array.from(
      this.runtimes.values(),
      (record): PtydTerminalRecord => ({
        ...record.summary,
        ownerPaneId: record.ownerPaneId
      })
    );
  }

  createTerminal(params: PtydTerminalCreateParams): PtydTerminalCreateResult {
    const existing = this.runtimes.get(params.runtimeId);
    if (existing) {
      return {
        ok: true,
        rootKey: this.rootKey,
        runtimeId: params.runtimeId,
        history: "",
        terminal: { ...existing.summary }
      };
    }

    if (
      params.paneId &&
      [...this.runtimes.values()].some((record) => record.ownerPaneId === params.paneId && record.summary.alive)
    ) {
      throw new Error(`Terminal pane '${params.paneId}' already has a live runtime`);
    }

    const cwd = normalizePath(params.cwd ?? this.rootDir);
    const shell = resolveDefaultShell();
    const pty = spawn(shell, resolveShellArgs(shell), {
      cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      name: resolveTerminalName(),
      env: createTerminalEnv(this.rootDir, params.appOrigin)
    });
    const now = new Date().toISOString();

    const summary: TerminalRuntimeSummary = {
      rootKey: this.rootKey,
      rootDir: this.rootDir,
      runtimeId: params.runtimeId,
      cwd,
      alive: true,
      createdAt: now,
      updatedAt: now,
      commandCount: 0
    };

    const record: TerminalRuntimeRecord = {
      ownerPaneId: params.paneId ?? null,
      summary,
      pty
    };
    pty.onData((data) => {
      const current = this.runtimes.get(params.runtimeId);
      if (current !== record) {
        return;
      }

      current.summary.updatedAt = new Date().toISOString();
      this.pushEvent({ type: "output", runtimeId: params.runtimeId, data });
    });
    pty.onExit((event) => {
      const current = this.runtimes.get(params.runtimeId);
      if (current !== record) {
        return;
      }

      current.summary.alive = false;
      current.summary.exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
      current.summary.signal =
        typeof event.signal === "string" || typeof event.signal === "number" ? String(event.signal) : null;
      current.summary.updatedAt = new Date().toISOString();
      this.pushEvent({ type: "state", terminal: { ...current.summary } });
    });

    this.runtimes.set(params.runtimeId, record);
    this.pushEvent({ type: "state", terminal: { ...summary } });

    return {
      ok: true,
      rootKey: this.rootKey,
      runtimeId: params.runtimeId,
      history: "",
      terminal: { ...summary }
    };
  }

  input(params: PtydTerminalInputParams): PtydTerminalInputResult {
    const record = this.runtimes.get(params.runtimeId);
    if (!record?.pty || !record.summary.alive) {
      return {
        ok: true,
        accepted: false,
        runtimeId: params.runtimeId,
        history: "",
        terminal: null
      };
    }

    record.summary.commandCount += 1;
    record.summary.updatedAt = new Date().toISOString();
    record.pty.write(params.data);
    this.pushEvent({ type: "state", terminal: { ...record.summary } });

    return {
      ok: true,
      accepted: true,
      runtimeId: params.runtimeId,
      history: "",
      terminal: { ...record.summary }
    };
  }

  resizeTerminal(params: PtydTerminalResizeParams): PtydTerminalResizeResult {
    const record = this.runtimes.get(params.runtimeId);
    if (!record?.pty || !record.summary.alive) {
      return {
        ok: true,
        accepted: false,
        runtimeId: params.runtimeId,
        terminal: null
      };
    }

    record.pty.resize(params.cols, params.rows);
    record.summary.updatedAt = new Date().toISOString();
    this.pushEvent({ type: "state", terminal: { ...record.summary } });

    return {
      ok: true,
      accepted: true,
      runtimeId: params.runtimeId,
      terminal: { ...record.summary }
    };
  }

  killTerminal(params: PtydTerminalKillParams): PtydTerminalKillResult {
    const record = this.runtimes.get(params.runtimeId);
    if (!record) {
      return {
        ok: true,
        rootKey: this.rootKey,
        runtimeId: params.runtimeId,
        killed: false,
        terminal: null
      };
    }

    this.runtimes.delete(params.runtimeId);
    if (record.pty) {
      try {
        record.pty.kill();
      } catch {}
      record.pty = null;
    }

    this.pushEvent({ type: "removed", runtimeId: params.runtimeId });
    return {
      ok: true,
      rootKey: this.rootKey,
      runtimeId: params.runtimeId,
      killed: true,
      terminal: null
    };
  }

  dispose() {
    for (const runtimeId of [...this.runtimes.keys()]) {
      this.killTerminal({ runtimeId });
    }
  }
}

function resolveDefaultShell() {
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

function resolveShellArgs(shell: string) {
  const shellName = shell.toLowerCase();
  if (process.platform === "win32") {
    if (
      shellName.endsWith("pwsh.exe") ||
      shellName.endsWith("pwsh") ||
      shellName.endsWith("powershell.exe") ||
      shellName.endsWith("powershell")
    ) {
      return ["-NoLogo"];
    }

    if (shellName.endsWith("cmd.exe") || shellName.endsWith("cmd")) {
      return [];
    }

    return ["-NoLogo"];
  }

  return ["-i"];
}

function resolveTerminalName() {
  return process.platform === "win32" ? "xterm-color" : "xterm-256color";
}

function createTerminalEnv(rootDir: string, appOrigin: string | undefined) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.FLMUX_ROOT = rootDir;
  env.TERM = resolveTerminalName();
  if (appOrigin) {
    env.FLMUX_ORIGIN = appOrigin;
  }
  prependToPath(env, join(rootDir, ".flmux", "bin"));
  return env;
}

/** Prepend `dir` to PATH, reusing the existing key's casing on Windows (where
 *  env names are case-insensitive but `Object.entries` preserves the source
 *  casing, so a blind `env.PATH =` would introduce a sibling entry). */
function prependToPath(env: Record<string, string>, dir: string): void {
  const existingKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = existingKey ? env[existingKey] : undefined;
  env[key] = current ? `${dir}${delimiter}${current}` : dir;
}

function normalizePath(value: string) {
  return process.platform === "win32" ? value.replace(/\//g, "\\") : value;
}
