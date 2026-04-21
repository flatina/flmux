import type { TerminalRuntimeEvent } from "../shared/terminal";

export interface TerminalHostAPI {
  subscribe(handler: (event: TerminalRuntimeEvent) => void): () => void;
}

const terminalEventSubscribers = new Set<(event: TerminalRuntimeEvent) => void>();

export function createTerminalHost(): TerminalHostAPI {
  return {
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
