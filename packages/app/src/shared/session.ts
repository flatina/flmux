export interface FlmuxWorkspaceSessionSnapshot {
  defaultTitle?: string;
  title: string;
  layout: unknown | null;
}

export interface FlmuxSessionSnapshot {
  version: 2;
  appTitle: string;
  activeWorkspaceId: string;
  workspaces: Record<string, FlmuxWorkspaceSessionSnapshot>;
}
