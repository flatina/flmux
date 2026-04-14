import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalRootStatus,
  TerminalRuntimeEvent,
  TerminalWriteResult
} from "../../shared/terminal";

export interface TerminalBackend {
  adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult>;
  create(input: TerminalCreateInput): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
  listRoots(): Promise<TerminalRootStatus[]>;
  subscribe(handler: (event: TerminalRuntimeEvent) => void): () => void;
  dispose?(): Promise<void> | void;
}
