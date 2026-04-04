import type { PaneId, TabId, TerminalRuntimeId } from "../../lib/ids";
import type { BrowserPaneAdapter, PaneKind } from "./pane-params";
import type { PaneCreateDirection, PaneCreateInput } from "../../types/pane";
import type { LayoutMode, PaneSummaryBase, WorkspaceSummaryBase, AppSummaryBase } from "../../types/view";
export type { PaneCreateDirection, PaneCreateInput, PaneResult } from "../../types/pane";

export interface WorkspaceSummary extends WorkspaceSummaryBase {}

export interface PaneSummary extends PaneSummaryBase {
  kind: PaneKind;
  ageMs?: number;
  isActive?: boolean;
  runtimeId?: TerminalRuntimeId;
  cwd?: string | null;
  shell?: string | null;
  renderer?: string;
  url?: string;
  adapter?: BrowserPaneAdapter;
  openerPaneId?: PaneId;
  filePath?: string | null;
  language?: string | null;
  rootPath?: string;
  mode?: string;
  viewKey?: string;
  extensionId?: string;
  viewId?: string;
}

export interface WorkspaceListResult {
  workspaces: WorkspaceSummary[];
}

export interface TabOpenParams {
  layoutMode: LayoutMode;
  title?: string;
}

export interface TabFocusParams {
  tabId: TabId;
}

export interface TabCloseParams {
  tabId: TabId;
}

export interface TabResult {
  ok: true;
  tabId: TabId;
}

export interface AppSummary extends AppSummaryBase {
  panes: PaneSummary[];
  browserAutomation: {
    cdpBaseUrl: string | null;
  };
}

export interface PaneSourceInfo {
  qualifiedId: string;
  label: string;
  icon: string;
  kind: string;
  viewKey?: string;
  defaultPlacement?: PaneCreateDirection;
  singleton?: boolean;
}

export type PaneSourcesResult = { sources: PaneSourceInfo[] };

export interface PaneOpenParams {
  leaf: PaneCreateInput;
  referencePaneId?: PaneId;
  direction?: PaneCreateDirection;
}

export interface PaneFocusParams {
  paneId: PaneId;
}

export interface PaneCloseParams {
  paneId: PaneId;
}

export interface PaneSplitParams {
  paneId: PaneId;
  direction: PaneCreateDirection;
  leaf: PaneCreateInput;
}

export interface PaneMessageParams {
  paneId: PaneId;
  eventType: string;
  data: unknown;
}

export interface PaneMessageResult {
  ok: true;
  delivered: boolean;
}

export interface BrowserPaneSummary {
  paneId: PaneId;
  tabId: TabId;
  title: string;
  url: string | null;
  adapter: BrowserPaneAdapter;
}

export interface BrowserPaneListResult {
  ok: true;
  panes: BrowserPaneSummary[];
}
