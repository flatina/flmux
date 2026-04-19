import type { PaneWorkspaceContext, WorkspaceBus } from "@flmux/core/shell";

// Single-source construction for the PaneWorkspaceContext an extension pane
// receives. The `bus` argument must be the workspace record's persistent
// WorkspaceBus — constructing a fresh one here silently breaks every
// extension's publish/subscribe (9896c66 regression).
export function buildPaneWorkspaceContext(args: {
  workspaceId: string;
  bus: WorkspaceBus;
  appOrigin: string;
}): PaneWorkspaceContext {
  return {
    id: args.workspaceId,
    defaultBrowserPath: `/__flmux/internal/start?workspace=${encodeURIComponent(args.workspaceId)}`,
    bus: args.bus,
    appOrigin: args.appOrigin
  };
}
