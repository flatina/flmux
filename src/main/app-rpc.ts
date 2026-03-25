import type {
  AppRpcMethod,
  AppRpcParams,
  AppRpcResult,
  BrowserPaneResult
} from "../shared/app-rpc";
import type { SessionId } from "../shared/ids";
import type { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import {
  browserBack,
  browserBox,
  browserClick,
  browserConnect,
  browserEval,
  browserFill,
  browserForward,
  browserGet,
  browserNavigate,
  browserNew,
  browserPress,
  browserReload,
  browserSnapshot,
  browserWait
} from "./browser-automation";

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

export class AppRpcDispatcher {
  constructor(private readonly handlers: AppRpcHandlers) {}

  invoke(method: string, params: unknown): Promise<unknown> {
    if (!(method in this.handlers)) {
      return Promise.reject(new Error(`Unknown method: ${method}`));
    }

    const handler = this.handlers[method as AppRpcMethod] as (params: unknown) => Promise<unknown> | unknown;

    return Promise.resolve(handler(params));
  }
}

export function createAppRpcHandlers(options: CreateAppRpcHandlersOptions): AppRpcHandlers {
  return {
    "system.ping": () => ({ pong: true }),
    "system.identify": async () => {
      const summary = await options.bridge.getSummary();
      return {
        app: "flmux" as const,
        sessionId: options.sessionId,
        workspaceRoot: options.workspaceRoot,
        pid: options.pid ?? process.pid,
        platform: options.platform ?? process.platform,
        activePaneId: summary.activePaneId,
        paneCount: summary.panes.length
      };
    },
    "app.summary": () => options.bridge.getSummary(),
    "pane.open": (params) => options.bridge.openPane(params),
    "pane.focus": (params) => options.bridge.focusPane(params),
    "pane.close": (params) => options.bridge.closePane(params),
    "pane.split": (params) => options.bridge.splitPane(params),
    "pane.message": (params) => options.bridge.sendPaneMessage(params),
    "tab.open": (params) => options.bridge.openTab(params),
    "tab.list": () => options.bridge.listTabs(),
    "tab.focus": (params) => options.bridge.focusTab(params),
    "tab.close": (params) => options.bridge.closeTab(params),
    "browser.targets": () => options.bridge.getBrowserTargets(),
    "browser.new": (params) => browserNew(options.bridge, params),
    "browser.list": () => options.bridge.listBrowserPanes(),
    "browser.focus": async (params) => toBrowserPaneResult((await options.bridge.focusPane({ paneId: params.paneId })).paneId),
    "browser.close": async (params) => toBrowserPaneResult((await options.bridge.closePane({ paneId: params.paneId })).paneId),
    "browser.connect": (params) => browserConnect(options.bridge, params),
    "browser.navigate": (params) => browserNavigate(options.bridge, params),
    "browser.get": (params) => browserGet(options.bridge, params),
    "browser.box": (params) => browserBox(options.bridge, params),
    "browser.snapshot": (params) => browserSnapshot(options.bridge, params),
    "browser.click": (params) => browserClick(options.bridge, params),
    "browser.fill": (params) => browserFill(options.bridge, params),
    "browser.press": (params) => browserPress(options.bridge, params),
    "browser.wait": (params) => browserWait(options.bridge, params),
    "browser.eval": (params) => browserEval(options.bridge, params),
    "browser.back": (params) => browserBack(options.bridge, params),
    "browser.forward": (params) => browserForward(options.bridge, params),
    "browser.reload": (params) => browserReload(options.bridge, params),
    "app.quit": () => {
      options.requestQuit?.();
      return { ok: true };
    }
  };
}

function toBrowserPaneResult(paneId: BrowserPaneResult["paneId"]): BrowserPaneResult {
  return { ok: true, paneId };
}
