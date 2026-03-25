import type { PaneId, SessionId } from "./ids";
import type { BrowserPaneAdapter } from "./pane-params";
import type {
  AppSummary,
  BrowserPaneListResult,
  PaneCloseParams,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitParams,
  TabCloseParams,
  TabFocusParams,
  TabListResult,
  TabOpenParams,
  TabResult
} from "./workspace-types";

export type {
  AppSummary,
  BrowserAutomationStatus,
  BrowserPaneInfo,
  BrowserPaneListResult,
  PaneCloseParams,
  PaneCreateDirection,
  PaneCreateInput,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitDirection,
  PaneSplitParams,
  PaneSummary,
  TabCloseParams,
  TabFocusParams,
  TabListResult,
  TabOpenParams,
  TabResult,
  TabSummary
} from "./workspace-types";

export interface SystemPingResult {
  pong: true;
}

export interface SystemIdentifyResult {
  app: "flmux";
  sessionId: SessionId;
  workspaceRoot: string;
  pid: number;
  platform: string;
  activePaneId: PaneId | null;
  paneCount: number;
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

export interface BrowserPaneResult {
  ok: true;
  paneId: PaneId;
}

export interface BrowserNewParams {
  url?: string;
  sourcePaneId?: PaneId;
  placement?: "auto" | "within" | "left" | "right" | "above" | "below";
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

export interface BrowserBoxParams {
  paneId: PaneId;
  target: string;
}

export interface BrowserBoxResult {
  ok: true;
  paneId: PaneId;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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
  kind: "duration" | "load" | "idle" | "target" | "text" | "url" | "fn";
  target?: string;
  text?: string;
  pattern?: string;
  expression?: string;
  ms?: number;
}

export interface BrowserActionResult {
  ok: true;
  paneId: PaneId;
}

export interface BrowserEvalParams {
  paneId: PaneId;
  script: string;
}

export interface BrowserEvalResult {
  ok: true;
  paneId: PaneId;
  value: unknown;
}

export interface BrowserPageActionParams {
  paneId: PaneId;
  waitUntil?: "none" | "load" | "idle";
  idleMs?: number;
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
  "browser.box": {
    params: BrowserBoxParams;
    result: BrowserBoxResult;
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
  "browser.eval": {
    params: BrowserEvalParams;
    result: BrowserEvalResult;
  };
  "browser.back": {
    params: BrowserPageActionParams;
    result: BrowserNavigateResult;
  };
  "browser.forward": {
    params: BrowserPageActionParams;
    result: BrowserNavigateResult;
  };
  "browser.reload": {
    params: BrowserPageActionParams;
    result: BrowserNavigateResult;
  };
  "app.quit": {
    params: undefined;
    result: { ok: true };
  };
}

export type AppRpcMethod = keyof AppRpcMethodMap;
export type AppRpcParams<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["params"];
export type AppRpcResult<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["result"];
