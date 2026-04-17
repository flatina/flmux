export interface FlmuxWorkspaceSessionSnapshot {
  defaultTitle?: string;
  title: string;
  innerLayout: unknown | null;
}

export interface FlmuxSessionSnapshot {
  version: 4;
  appTitle: string;
  outerLayout: unknown | null;
  workspaces: Record<string, FlmuxWorkspaceSessionSnapshot>;
}
