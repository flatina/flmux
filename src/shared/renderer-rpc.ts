import type { PaneId } from "./ids";
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

export interface RendererRpcMethodMap {
  "workspace.summary": {
    params: undefined;
    result: AppSummary;
  };
  "workspace.open": {
    params: PaneOpenParams;
    result: PaneResult;
  };
  "workspace.focus": {
    params: PaneFocusParams;
    result: PaneResult;
  };
  "workspace.close": {
    params: PaneCloseParams;
    result: PaneResult;
  };
  "workspace.split": {
    params: PaneSplitParams;
    result: PaneResult;
  };
  "workspace.tab.open": {
    params: TabOpenParams;
    result: TabResult;
  };
  "workspace.tab.list": {
    params: undefined;
    result: TabListResult;
  };
  "workspace.tab.focus": {
    params: TabFocusParams;
    result: TabResult;
  };
  "workspace.tab.close": {
    params: TabCloseParams;
    result: TabResult;
  };
  "workspace.pane.message": {
    params: PaneMessageParams;
    result: PaneMessageResult;
  };
  "workspace.browser.list": {
    params: undefined;
    result: BrowserPaneListResult;
  };
  "workspace.browser.new": {
    params: {
      url?: string;
      sourcePaneId?: PaneId;
      placement?: "auto" | "within" | "left" | "right" | "above" | "below";
    };
    result: {
      ok: true;
      paneId: PaneId;
    };
  };
}

export type RendererPushMessageMap = {};

export type RendererRpcMethod = keyof RendererRpcMethodMap;
export type RendererRpcParams<Method extends RendererRpcMethod> = RendererRpcMethodMap[Method]["params"];
export type RendererRpcResult<Method extends RendererRpcMethod> = RendererRpcMethodMap[Method]["result"];

export type RendererRpcRequestProxy = {
  [Method in RendererRpcMethod]: (params: RendererRpcParams<Method>) => Promise<RendererRpcResult<Method>>;
};

export type RendererRpcRequestHandlers = {
  [Method in RendererRpcMethod]?: (
    params: RendererRpcParams<Method>
  ) => Promise<RendererRpcResult<Method>> | RendererRpcResult<Method>;
};
