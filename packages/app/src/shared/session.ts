export interface FlmuxWorkspaceSessionSnapshot {
  title: string;
  layout: unknown | null;
}

export interface FlmuxSessionSnapshot {
  version: 1;
  appTitle: string;
  activeWorkspaceId: string;
  workspaces: Record<string, FlmuxWorkspaceSessionSnapshot>;
}
