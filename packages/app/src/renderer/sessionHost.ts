import type { FlmuxSessionSnapshot } from "../shared/session";
import type { FlmuxHostRequestProxy } from "../shared/rendererBridge";

export interface SessionHostAPI {
  load(): Promise<FlmuxSessionSnapshot | null>;
  save(snapshot: FlmuxSessionSnapshot): Promise<void>;
}

export function createSessionHost(proxy: FlmuxHostRequestProxy): SessionHostAPI {
  return {
    load() {
      return proxy["flmux.session.load"]();
    },

    async save(snapshot) {
      await proxy["flmux.session.save"](snapshot);
    }
  };
}
