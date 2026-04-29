import { createWorkspaceStatusStore, type PaneWorkspaceContext, type WorkspaceBus } from "@flmux/core/shell";

const noopBus: WorkspaceBus = {
  publish() {},
  subscribe() {
    return () => {};
  }
};

export function makePaneWorkspaceContext(overrides: Partial<PaneWorkspaceContext> = {}): PaneWorkspaceContext {
  const id = overrides.id ?? "workspace.test";
  return {
    id,
    defaultBrowserPath: overrides.defaultBrowserPath ?? `/__flmux/internal/start?workspace=${id}`,
    bus: overrides.bus ?? noopBus,
    workspaceStatus: overrides.workspaceStatus ?? createWorkspaceStatusStore(),
    appOrigin: overrides.appOrigin ?? "http://localhost:0"
  };
}
