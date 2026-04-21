import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalRootStatus,
  TerminalRuntimeEvent,
  TerminalWriteResult
} from "./types";

export interface TerminalBackend {
  /** `rootDir` is the daemon scope dir (= install root). */
  adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult>;
  create(input: TerminalCreateInput): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
  listRoots(): Promise<TerminalRootStatus[]>;
  /** Attach to the daemon for `rootDir` if one is already running, without
   * launching. Returns null when no daemon exists for that rootDir. */
  probeRoot(rootDir: string): Promise<TerminalRootStatus | null>;
  subscribe(handler: (event: TerminalRuntimeEvent) => void): () => void;
  dispose?(): Promise<void> | void;
}
