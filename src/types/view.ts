import type { PaneCreateDirection, PaneCreateInput, PaneResult } from "./pane";
import type { PaneId, TabId } from "./ids";
import type { PropertyHandle } from "./property";
import type { PaneOpenOptions } from "./setup";

export type ViewKey = string;

export function createViewKey(extensionId: string, viewId: string): ViewKey {
  return `${extensionId}:${viewId}`;
}

export function parseViewKey(viewKey: ViewKey): { extensionId: string; viewId: string } | null {
  const idx = viewKey.indexOf(":");
  if (idx <= 0 || idx === viewKey.length - 1) return null;
  return { extensionId: viewKey.slice(0, idx), viewId: viewKey.slice(idx + 1) };
}

export interface AppProps { title: string }
export interface WorkspaceProps { title: string }
export interface PaneProps { title: string }

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
export type AppPropKey = keyof AppProps;
export type WorkspacePropKey = keyof WorkspaceProps;
export type PanePropKey = keyof PaneProps;

export type LayoutMode = "simple" | "stack" | "layoutable";
export type PropsByScope = { app: AppProps; workspace: WorkspaceProps; pane: PaneProps };
export type PropScope = keyof PropsByScope;

export type ScopeListener = (...args: unknown[]) => void;

export interface ScopeEmitter {
  emit: (eventType: string, ...args: unknown[]) => void;
  on: (eventType: string, handler: ScopeListener) => () => void;
}

export interface App extends ScopeEmitter {
  title: AppProps["title"];
  readonly props: PropertyHandle;
}

export interface Workspace extends ScopeEmitter {
  readonly tabId: TabId;
  title: WorkspaceProps["title"];
  readonly props: PropertyHandle;
}

export interface Pane extends ScopeEmitter {
  readonly paneId: PaneId;
  title: PaneProps["title"];
  readonly props: PropertyHandle;
}

export interface HeaderAction {
  id: string;
  icon: string;
  tooltip?: string;
  onClick: () => void;
}

export interface PaneSummaryBase {
  paneId: PaneId;
  tabId: TabId;
  kind: string;
  title: string;
}

export interface WorkspaceSummaryBase {
  tabId: TabId;
  layoutMode: LayoutMode;
  title: string;
  paneCount: number;
}

export interface AppSummaryBase {
  title: string;
  activePaneId: PaneId | null;
  webServerUrl: string | null;
}

export interface Context<Params = Record<string, never>, State extends object = Record<string, never>> {
  viewKey: ViewKey;
  paneId: PaneId;
  tabId: TabId;
  workspaceRoot: string;
  webPort: number | null;
  params: Readonly<Params>;
  state: Readonly<State> | undefined;
  loadAssetText: (path: string) => Promise<string>;
  fs: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    readDir: (path: string) => Promise<Array<{ name: string; path: string; isDir: boolean; size?: number }>>;
  };
  setState: (nextState: Partial<State>) => void;
  app: App;
  curWorkspace: Workspace;
  curPane: Pane;
  getAppSummary: () => AppSummaryBase & { panes: PaneSummaryBase[] };
  listTabs: () => WorkspaceSummaryBase[];
  getWorkspace: (tabId: TabId) => Workspace;
  getPane: (paneId: PaneId) => Pane;
  setHeaderActions: (actions: HeaderAction[]) => void;
  openPane: (
    leaf: PaneCreateInput,
    placement?: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
    options?: PaneOpenOptions
  ) => Promise<PaneResult>;
  onActiveChange: (handler: (isActive: boolean) => void) => () => void;
  onVisibilityChange: (handler: (visible: boolean) => void) => () => void;
  onDimensionsChange: (handler: () => void) => () => void;
  getResolvedTheme: () => ResolvedTheme;
  onThemeChange: (handler: (theme: ResolvedTheme) => void) => () => void;
}

export interface FlmuxViewInstance<Params = Record<string, never>> {
  beforeMount?: (host: HTMLElement) => void | Promise<void>;
  mount: (host: HTMLElement) => void | Promise<void>;
  update?: (nextParams: Params) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export interface FlmuxView<Params = Record<string, never>, State extends object = Record<string, never>> {
  createInstance: (context: Context<Params, State>) => FlmuxViewInstance<Params> | Promise<FlmuxViewInstance<Params>>;
}
