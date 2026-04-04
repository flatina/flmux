import type { AppRpcMethod, AppRpcParams, AppRpcResult } from "../rpc/app-rpc";
import type { SessionId } from "../../lib/ids";
import type { RendererWorkspaceBridge } from "./renderer-workspace-bridge";

export type AppRpcHandlers = {
  [Method in AppRpcMethod]: (params: AppRpcParams<Method>) => Promise<AppRpcResult<Method>> | AppRpcResult<Method>;
};

export interface CreateAppRpcHandlersOptions {
  bridge: RendererWorkspaceBridge;
  sessionId: SessionId;
  workspaceRoot: string;
  pid?: number;
  platform?: string;
  requestQuit?: () => void;
}

export function createAppRpcHandlers(options: CreateAppRpcHandlersOptions): AppRpcHandlers {
  const { bridge } = options;
  return {
    "system.ping": () => ({ pong: true }),
    "system.identify": async () => {
      try {
        const summary = await bridge.request("workspace.summary", undefined);
        return {
          app: "flmux" as const,
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
          pid: options.pid ?? process.pid,
          platform: options.platform ?? process.platform,
          activePaneId: summary.activePaneId,
          paneCount: summary.panes.length
        };
      } catch {
        return {
          app: "flmux" as const,
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
          pid: options.pid ?? process.pid,
          platform: options.platform ?? process.platform,
          activePaneId: null,
          paneCount: 0
        };
      }
    },
    "app.summary": () => bridge.request("workspace.summary", undefined),
    "props.get": (params) => bridge.request("workspace.props.get", { scope: params.scope, targetId: params.targetId, key: params.key }),
    "props.list": (params) => bridge.request("workspace.props.list", { scope: params.scope, targetId: params.targetId }),
    "props.schema": (params) => bridge.request("workspace.props.schema", { scope: params.scope, targetId: params.targetId }),
    "props.set": async (params) => {
      const schema = await bridge.request("workspace.props.schema", { scope: params.scope, targetId: params.targetId });
      const info = (schema.properties as Record<string, { readonly?: boolean }>)[params.key];
      if (info?.readonly) throw new Error(`Property is readonly: ${params.scope}.${params.key}`);
      return bridge.request("workspace.props.set", { scope: params.scope, targetId: params.targetId, key: params.key, value: params.value });
    },
    "pane.sources": () => bridge.request("workspace.sources", undefined),
    "pane.open": (params) => bridge.request("workspace.open", params),
    "pane.focus": (params) => bridge.request("workspace.focus", params),
    "pane.close": (params) => bridge.request("workspace.close", params),
    "pane.split": (params) => bridge.request("workspace.split", params),
    "pane.message": (params) => bridge.request("workspace.pane.message", params),
    "tab.open": (params) => bridge.request("workspace.tab.open", params),
    "tab.list": () => bridge.request("workspace.tab.list", undefined),
    "tab.focus": (params) => bridge.request("workspace.tab.focus", params),
    "tab.close": (params) => bridge.request("workspace.tab.close", params),
    "app.quit": () => {
      options.requestQuit?.();
      return { ok: true };
    }
  };
}
