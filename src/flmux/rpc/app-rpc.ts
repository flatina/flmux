import type { PaneId, SessionId, TabId } from "../../lib/ids";
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
import type { PropertyScope } from "../../types/property";

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
  "props.get": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId; key: string };
    result: { ok: true; found: boolean; value: unknown };
  };
  "props.list": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId };
    result: { ok: true; values: Record<string, unknown> };
  };
  "props.schema": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId };
    result: { ok: true; properties: Record<string, unknown> };
  };
  "props.set": {
    params: { scope: PropertyScope; targetId?: PaneId | TabId; key: string; value: unknown };
    result: { ok: true; value: unknown };
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
    result: WorkspaceListResult;
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
  "app.quit": {
    params: undefined;
    result: { ok: true };
  };
}

export type AppRpcMethod = keyof AppRpcMethodMap;
export type AppRpcParams<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["params"];
export type AppRpcResult<Method extends AppRpcMethod> = AppRpcMethodMap[Method]["result"];
