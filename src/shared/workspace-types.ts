import type { PaneId, TabId, TerminalRuntimeId } from "./ids";
import type { BrowserPaneAdapter, ExplorerMode, PaneKind, TerminalRenderer } from "./pane-params";
import type { LayoutMode } from "./tab-params";

export interface PaneSummary {
  paneId: PaneId;
  tabId: TabId;
  kind: PaneKind;
  title: string;
  runtimeId?: TerminalRuntimeId;
  url?: string;
  filePath?: string | null;
  rootPath?: string;
  extensionId?: string;
  contributionId?: string;
}

export interface TabSummary {
  tabId: TabId;
  layoutMode: LayoutMode;
  title: string;
  paneCount: number;
}

export interface TabListResult {
  tabs: TabSummary[];
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

export interface AppSummary {
  activePaneId: PaneId | null;
  panes: PaneSummary[];
  webServerUrl: string | null;
  browserAutomation: {
    cdpBaseUrl: string | null;
  };
}

export type PaneCreateDirection = "within" | "left" | "right" | "above" | "below";
export type PaneSplitDirection = Exclude<PaneCreateDirection, "within">;

export type PaneCreateInput =
  | {
      kind: "terminal";
      title?: string;
      cwd?: string | null;
      shell?: string | null;
      renderer?: TerminalRenderer;
      startupCommands?: string[];
    }
  | {
      kind: "browser";
      title?: string;
      url?: string;
      adapter?: BrowserPaneAdapter;
    }
  | {
      kind: "editor";
      title?: string;
      filePath?: string | null;
      language?: string | null;
    }
  | {
      kind: "explorer";
      title?: string;
      rootPath?: string;
      mode?: ExplorerMode;
    }
  | {
      kind: "extension";
      title?: string;
      extensionId: string;
      contributionId: string;
    };

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
  direction: PaneSplitDirection;
  leaf: PaneCreateInput;
}

export interface PaneResult {
  ok: true;
  paneId: PaneId;
  activePaneId: PaneId | null;
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

export type BrowserAutomationStatus = "ready" | "pending" | "unsupported";

export interface BrowserPaneInfo {
  paneId: PaneId;
  tabId: TabId;
  title: string;
  url: string | null;
  adapter: BrowserPaneAdapter;
  webviewId: number | null;
  automationStatus: BrowserAutomationStatus;
  automationReason?: string;
}

export interface BrowserPaneListResult {
  ok: true;
  panes: BrowserPaneInfo[];
}
