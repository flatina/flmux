import type { ShellModelAPI } from "@flmux/core/shell";
import type { SessionCap } from "../../shared/rendererBridge";

export function createShellModelClientOverSession(session: SessionCap): ShellModelAPI {
  return {
    pathGet: (path, caller) =>
      session.get({ path, sourcePaneId: caller?.sourcePaneId, workspaceId: caller?.workspaceId }),
    pathList: (path, caller) =>
      session.list({ path, sourcePaneId: caller?.sourcePaneId, workspaceId: caller?.workspaceId }),
    pathSet: (path, value, caller) =>
      session.set({ path, value, sourcePaneId: caller?.sourcePaneId, workspaceId: caller?.workspaceId }),
    pathCall: (path, args, caller) =>
      session.call({ path, args, sourcePaneId: caller?.sourcePaneId, workspaceId: caller?.workspaceId })
  };
}
