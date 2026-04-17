export interface FlmuxWorkspaceSessionSnapshot {
  defaultTitle?: string;
  title: string;
  innerLayout: unknown | null;
}

export interface FlmuxSessionSnapshot {
  version: 3;
  appTitle: string;
  workspaces: Record<string, FlmuxWorkspaceSessionSnapshot>;
}
