import type { PaneId, SessionId, TabId, TerminalRuntimeId } from "./ids";
import type { BrowserPaneAdapter, ExplorerMode, PaneKind, TerminalRenderer } from "./pane-params";
import type { LayoutMode } from "./tab-params";

export interface SystemPingResult {
  pong: true;
}

export interface SystemIdentifyResult {
  app: "flmux";
  sessionId: SessionId;
  pid: number;
  platform: string;
  activePaneId: PaneId | null;
  paneCount: number;
}

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

export interface BrowserTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserTargetsResult {
  ok: true;
  cdpBaseUrl: string | null;
  targets: BrowserTarget[];
}

export interface AppRpcMethodMap {
  "system.ping": {
    params: undefined;
    result: SystemPingResult;
  };
  "system.identify": {
    params: undefined;
    result: SystemIdentifyResult;
  };
  "app.summary": {
    params: undefined;
    result: AppSummary;
  };
  "pane.open": {
    params: PaneOpenParams;
    result: PaneResult;
  };
  "pane.focus": {
    params: PaneFocusParams;
    result: PaneResult;
  };
  "pane.close": {
    params: PaneCloseParams;
    result: PaneResult;
  };
  "pane.split": {
    params: PaneSplitParams;
    result: PaneResult;
  };
  "tab.open": {
    params: TabOpenParams;
    result: TabResult;
  };
  "tab.list": {
    params: undefined;
    result: TabListResult;
  };
  "tab.focus": {
    params: TabFocusParams;
    result: TabResult;
  };
  "tab.close": {
    params: TabCloseParams;
    result: TabResult;
  };
  "pane.message": {
    params: PaneMessageParams;
    result: PaneMessageResult;
  };
  "browser.targets": {
    params: undefined;
    result: BrowserTargetsResult;
  };
  "app.quit": {
    params: undefined;
    result: { ok: true };
  };
}

export type AppRpcMethod = keyof AppRpcMethodMap;
export type AppRpcParams<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["params"];
export type AppRpcResult<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["result"];
