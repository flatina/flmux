import type { ShellModelAPI } from "@flmux/core/shell";
import type { FlmuxHostRequestProxy } from "../../shared/rendererBridge";

export function createShellModelClientOverPreload(proxy: FlmuxHostRequestProxy): ShellModelAPI {
  return {
    pathGet: (path) => proxy["shellModel.path.get"]({ path }),
    pathList: (path) => proxy["shellModel.path.list"]({ path }),
    pathSet: (path, value) => proxy["shellModel.path.set"]({ path, value }),
    pathCall: (path, args, caller) => proxy["shellModel.path.call"]({ path, args, caller })
  };
}
