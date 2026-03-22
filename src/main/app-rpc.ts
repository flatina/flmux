import type {
  AppRpcMethod,
  AppRpcParams,
  AppRpcResult,
  AppSummary,
  BrowserTargetsResult,
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
} from "../shared/app-rpc";
import type { SessionId } from "../shared/ids";

export type AppRpcHandlers = {
  [Method in AppRpcMethod]: (params: AppRpcParams<Method>) => Promise<AppRpcResult<Method>> | AppRpcResult<Method>;
};

export interface WorkspaceRpcAdapter {
  getSummary(): Promise<AppSummary>;
  openPane(params: PaneOpenParams): Promise<PaneResult>;
  focusPane(params: PaneFocusParams): Promise<PaneResult>;
  closePane(params: PaneCloseParams): Promise<PaneResult>;
  splitPane(params: PaneSplitParams): Promise<PaneResult>;
  openTab(params: TabOpenParams): Promise<TabResult>;
  listTabs(): Promise<TabListResult>;
  focusTab(params: TabFocusParams): Promise<TabResult>;
  closeTab(params: TabCloseParams): Promise<TabResult>;
  getBrowserTargets(): Promise<BrowserTargetsResult>;
  sendPaneMessage(params: PaneMessageParams): Promise<PaneMessageResult>;
}

export interface CreateAppRpcHandlersOptions {
  workspace: WorkspaceRpcAdapter;
  sessionId: SessionId;
  pid?: number;
  platform?: string;
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
      const summary = await options.workspace.getSummary();

      return {
        app: "flmux",
        sessionId: options.sessionId,
        pid: options.pid ?? process.pid,
        platform: options.platform ?? process.platform,
        activePaneId: summary.activePaneId,
        paneCount: summary.panes.length
      };
    },
    "app.summary": () => options.workspace.getSummary(),
    "pane.open": (params) => options.workspace.openPane(params),
    "pane.focus": (params) => options.workspace.focusPane(params),
    "pane.close": (params) => options.workspace.closePane(params),
    "pane.split": (params) => options.workspace.splitPane(params),
    "pane.message": (params) => options.workspace.sendPaneMessage(params),
    "tab.open": (params) => options.workspace.openTab(params),
    "tab.list": () => options.workspace.listTabs(),
    "tab.focus": (params) => options.workspace.focusTab(params),
    "tab.close": (params) => options.workspace.closeTab(params),
    "browser.targets": () => options.workspace.getBrowserTargets(),
    "app.quit": () => {
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    }
  };
}
