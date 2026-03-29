import type { PaneId, TabId } from "../../lib/ids";
import type {
  AppSummary,
  PaneCloseParams,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitParams,
  TabCloseParams,
  TabFocusParams,
  WorkspaceListResult,
  TabOpenParams,
  TabResult
} from "../model/workspace-types";
import type { PropertyChangeEvent, PropertyScope } from "../../types/property";

export interface RendererRpcMethodMap {
  "workspace.summary": {
    params: undefined;
    result: AppSummary;
  };
  "workspace.props.get": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId; key: string };
    result: { ok: true; found: boolean; value: unknown };
  };
  "workspace.props.list": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId };
    result: { ok: true; values: Record<string, unknown> };
  };
  "workspace.props.schema": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId };
    result: { ok: true; properties: Record<string, unknown> };
  };
  "workspace.props.set": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId; key: string; value: unknown };
    result: { ok: true; value: unknown };
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
    result: WorkspaceListResult;
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
}

export interface RendererPushMessageMap {
  "workspace.props.changed": PropertyChangeEvent;
}

export type RendererRpcMethod = keyof RendererRpcMethodMap;
export type RendererRpcParams<Method extends RendererRpcMethod> = RendererRpcMethodMap[Method]["params"];
export type RendererRpcResult<Method extends RendererRpcMethod> = RendererRpcMethodMap[Method]["result"];
export type RendererPushMessage = keyof RendererPushMessageMap;
export type RendererPushPayload<Message extends RendererPushMessage> = RendererPushMessageMap[Message];

export type RendererRpcRequestProxy = {
  [Method in RendererRpcMethod]: (params: RendererRpcParams<Method>) => Promise<RendererRpcResult<Method>>;
};

export type RendererRpcRequestHandlers = {
  [Method in RendererRpcMethod]?: (
    params: RendererRpcParams<Method>
  ) => Promise<RendererRpcResult<Method>> | RendererRpcResult<Method>;
};
