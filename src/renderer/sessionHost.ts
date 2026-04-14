import type { FlmuxSessionSnapshot } from "../shared/session";

declare global {
  interface Window {
    bunite?: { invoke: (method: string, params?: unknown) => Promise<unknown> };
  }
}

export interface SessionHostAPI {
  load(): Promise<FlmuxSessionSnapshot | null>;
  save(snapshot: FlmuxSessionSnapshot): Promise<void>;
}

export function createSessionHost(): SessionHostAPI {
  const invoke = window.bunite?.invoke;
  if (!invoke) {
    throw new Error("bunite runtime not available for session host");
  }

  return {
    async load() {
      return invoke("flmux.session.load") as Promise<FlmuxSessionSnapshot | null>;
    },

    async save(snapshot) {
      await invoke("flmux.session.save", snapshot);
    }
  };
}
