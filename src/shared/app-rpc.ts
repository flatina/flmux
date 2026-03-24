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

export interface BrowserPaneResult {
  ok: true;
  paneId: PaneId;
}

export interface BrowserNewParams {
  url?: string;
}

export interface BrowserConnectParams {
  paneId: PaneId;
}

export type BrowserConnectErrorCode =
  | "pane_not_found"
  | "unsupported_adapter"
  | "pane_not_ready"
  | "cdp_unavailable"
  | "target_not_found"
  | "target_ambiguous";

export type BrowserConnectResult =
  | {
      ok: true;
      paneId: PaneId;
      url: string | null;
      title: string;
      adapter: BrowserPaneAdapter;
      webviewId: number | null;
    }
  | {
      ok: false;
      paneId: PaneId;
      error: string;
      code: BrowserConnectErrorCode;
      candidates?: Array<{ id: string; title: string; url: string }>;
    };

export interface BrowserNavigateParams {
  paneId: PaneId;
  url: string;
  waitUntil?: "none" | "load" | "idle";
  idleMs?: number;
}

export interface BrowserNavigateResult {
  ok: true;
  paneId: PaneId;
  url: string;
}

export interface BrowserGetParams {
  paneId: PaneId;
  field: "url" | "title" | "text" | "html" | "value" | "attr";
  target?: string;
  name?: string;
}

export interface BrowserGetResult {
  ok: true;
  paneId: PaneId;
  field: "url" | "title" | "text" | "html" | "value" | "attr";
  value: string;
}

export interface BrowserSnapshotParams {
  paneId: PaneId;
  compact?: boolean;
}

export interface BrowserSnapshotResult {
  ok: true;
  paneId: PaneId;
  snapshot: string;
}

export interface BrowserClickParams {
  paneId: PaneId;
  target: string;
}

export interface BrowserFillParams {
  paneId: PaneId;
  target: string;
  text: string;
}

export interface BrowserPressParams {
  paneId: PaneId;
  key: string;
}

export interface BrowserWaitParams {
  paneId: PaneId;
  kind: "duration" | "load" | "idle" | "target";
  target?: string;
  ms?: number;
}

export interface BrowserActionResult {
  ok: true;
  paneId: PaneId;
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
  "browser.new": {
    params: BrowserNewParams;
    result: BrowserPaneResult;
  };
  "browser.list": {
    params: undefined;
    result: BrowserPaneListResult;
  };
  "browser.focus": {
    params: BrowserConnectParams;
    result: BrowserPaneResult;
  };
  "browser.close": {
    params: BrowserConnectParams;
    result: BrowserPaneResult;
  };
  "browser.connect": {
    params: BrowserConnectParams;
    result: BrowserConnectResult;
  };
  "browser.navigate": {
    params: BrowserNavigateParams;
    result: BrowserNavigateResult;
  };
  "browser.get": {
    params: BrowserGetParams;
    result: BrowserGetResult;
  };
  "browser.snapshot": {
    params: BrowserSnapshotParams;
    result: BrowserSnapshotResult;
  };
  "browser.click": {
    params: BrowserClickParams;
    result: BrowserActionResult;
  };
  "browser.fill": {
    params: BrowserFillParams;
    result: BrowserActionResult;
  };
  "browser.press": {
    params: BrowserPressParams;
    result: BrowserActionResult;
  };
  "browser.wait": {
    params: BrowserWaitParams;
    result: BrowserActionResult;
  };
  "app.quit": {
    params: undefined;
    result: { ok: true };
  };
}

export type AppRpcMethod = keyof AppRpcMethodMap;
export type AppRpcParams<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["params"];
export type AppRpcResult<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["result"];
