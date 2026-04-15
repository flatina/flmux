import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalRuntimeEvent,
  TerminalRootStatus,
  TerminalWriteResult
} from "../shared/terminal";
import type { FlmuxHostRequestProxy } from "../shared/rendererBridge";

export interface TerminalHostAPI {
  adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult>;
  create(input: TerminalCreateInput): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
  listRoots(): Promise<TerminalRootStatus[]>;
  onEvent(handler: (event: TerminalRuntimeEvent) => void): () => void;
}

const terminalEventSubscribers = new Set<(event: TerminalRuntimeEvent) => void>();

export function createTerminalHost(proxy: FlmuxHostRequestProxy): TerminalHostAPI {
  return {
    adoptByPaneId(input) {
      return proxy["flmux.terminal.adopt"](input);
    },
    create(input) {
      return proxy["flmux.terminal.create"](input);
    },
    write(input) {
      return proxy["flmux.terminal.write"](input);
    },
    resize(input) {
      return proxy["flmux.terminal.resize"](input);
    },
    history(input) {
      return proxy["flmux.terminal.history"](input);
    },
    kill(input) {
      return proxy["flmux.terminal.kill"](input);
    },
    listRoots() {
      return proxy["flmux.terminal.listRoots"]();
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
