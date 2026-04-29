import type { PaneWorkspaceContext, WorkspaceBus, WorkspaceStatusStore } from "@flmux/core/shell";

// Single-source construction for the PaneWorkspaceContext an extension pane
// receives. The `bus` and `workspaceStatus` arguments must be the workspace
// record's persistent instances — constructing fresh ones here silently
// breaks every extension's publish/subscribe and shared status reads.
export function buildPaneWorkspaceContext(args: {
  workspaceId: string;
  bus: WorkspaceBus;
  workspaceStatus: WorkspaceStatusStore;
  appOrigin: string;
}): PaneWorkspaceContext {
  return {
    id: args.workspaceId,
    defaultBrowserPath: `/__flmux/internal/start?workspace=${encodeURIComponent(args.workspaceId)}`,
    bus: args.bus,
    workspaceStatus: args.workspaceStatus,
    appOrigin: args.appOrigin
  };
}
