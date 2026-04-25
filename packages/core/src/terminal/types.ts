export interface TerminalCreateInput {
  /** Daemon scope dir (= install root). Selects which ptyd daemon owns the runtime. */
  rootDir: string;
  cwd?: string;
  paneId?: string;
  /** App server origin — injected into the PTY env as `FLMUX_ORIGIN` so CLI
   * commands run from inside the terminal reach the right server without the
   * `--origin` flag. Set by trusted main-side callers; never threaded from
   * public path.call args. Only applies to fresh spawns (adopted runtimes
   * keep their original env). */
  appOrigin?: string;
}

export interface TerminalRuntimeSummary {
  rootKey: string;
  rootDir: string;
  runtimeId: string;
  cwd: string;
  alive: boolean;
  createdAt: string;
  updatedAt: string;
  commandCount: number;
  /** `pty.onExit` exit code; absent while alive, `null` if unreported. */
  exitCode?: number | null;
  /** `pty.onExit` signal (e.g. "SIGTERM"); absent on clean exit. */
  signal?: string | null;
}

export interface TerminalCreateResult {
  ok: true;
  rootKey: string;
  runtimeId: string;
  history: string;
  terminal: TerminalRuntimeSummary;
}

export interface TerminalWriteResult {
  ok: true;
  accepted: boolean;
  runtimeId: string;
  history: string;
  terminal: TerminalRuntimeSummary | null;
}

export interface TerminalResizeResult {
  ok: true;
  accepted: boolean;
  runtimeId: string;
  terminal: TerminalRuntimeSummary | null;
}

export interface TerminalHistoryResult {
  ok: true;
  runtimeId: string;
  data: string;
}

export interface TerminalKillResult {
  ok: true;
  rootKey: string;
  runtimeId: string;
  killed: boolean;
  terminal: TerminalRuntimeSummary | null;
}

export type TerminalAdoptResult =
  | {
      ok: true;
      outcome: "adopted";
      rootKey: string;
      runtimeId: string;
      history: string;
      terminal: TerminalRuntimeSummary;
    }
  | {
      ok: true;
      outcome: "not_found";
    };

export interface TerminalRootStatus {
  rootKey: string;
  rootDir: string;
  runtimeCount: number;
  updatedAt: string;
}

export type TerminalRuntimeEvent =
  | { type: "state"; paneId?: string | null; terminal: TerminalRuntimeSummary }
  | { type: "output"; paneId?: string | null; runtimeId: string; data: string }
  | { type: "removed"; paneId?: string | null; runtimeId: string };
