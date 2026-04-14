import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalRuntimeEvent,
  TerminalRootStatus,
  TerminalWriteResult
} from "../shared/terminal";

declare global {
  interface Window {
    bunite?: { invoke: (method: string, params?: unknown) => Promise<unknown> };
  }
}

export interface TerminalHostAPI {
  adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult>;
  create(input: TerminalCreateInput): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
  listRoots(): Promise<TerminalRootStatus[]>;
  onEvent(handler: (event: TerminalRuntimeEvent) => void): () => void;
}

const terminalEventSubscribers = new Set<(event: TerminalRuntimeEvent) => void>();

export function createTerminalHost(): TerminalHostAPI {
  const invoke = window.bunite?.invoke;
  if (!invoke) {
    throw new Error("bunite runtime not available for terminal host");
  }

  return {
    adoptByPaneId(input) {
      return invoke("flmux.terminal.adopt", input) as Promise<TerminalAdoptResult>;
    },
    create(input) {
      return invoke("flmux.terminal.create", input) as Promise<TerminalCreateResult>;
    },
    write(input) {
      return invoke("flmux.terminal.write", input) as Promise<TerminalWriteResult>;
    },
    history(input) {
      return invoke("flmux.terminal.history", input) as Promise<TerminalHistoryResult>;
    },
    kill(input) {
      return invoke("flmux.terminal.kill", input) as Promise<TerminalKillResult>;
    },
    listRoots() {
      return invoke("flmux.terminal.listRoots") as Promise<TerminalRootStatus[]>;
    },
    onEvent(handler) {
      terminalEventSubscribers.add(handler);
      return () => {
        terminalEventSubscribers.delete(handler);
      };
    }
  };
}

export function pushTerminalEvent(event: TerminalRuntimeEvent) {
  for (const subscriber of terminalEventSubscribers) {
    subscriber(event);
  }
}
