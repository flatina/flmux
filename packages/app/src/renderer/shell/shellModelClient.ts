import type { ShellModelAPI } from "@flmux/core/shell";
import type { ShellCapClient } from "../../shared/rendererBridge";

export function createShellModelClientOverPreload(shell: ShellCapClient): ShellModelAPI {
  return {
    pathGet: (path) => shell.get({ path }),
    pathList: (path) => shell.list({ path }),
    pathSet: (path, value) => shell.set({ path, value }),
    pathCall: (path, args, caller) => shell.call({ path, args, caller })
  };
}
