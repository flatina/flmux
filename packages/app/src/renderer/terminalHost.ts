import type { TerminalBackend } from "@flmux/core/terminal/backend";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import type { FlmuxHostRequestProxy } from "../shared/rendererBridge";

export interface TerminalHostAPI extends TerminalBackend {}

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
    subscribe(handler) {
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
