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
} from "./terminal";

export interface TerminalBackend {
  adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult>;
  create(input: TerminalCreateInput): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
  listRoots(): Promise<TerminalRootStatus[]>;
  subscribe(handler: (event: TerminalRuntimeEvent) => void): () => void;
  dispose?(): Promise<void> | void;
}
