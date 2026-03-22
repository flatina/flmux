import type {
  AppSummary,
  BrowserTarget,
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
import type { RendererRpcRequestProxy } from "../shared/renderer-rpc";

type WindowWithRendererRpc = {
  webview: {
    rpc?: unknown;
  };
};

export class RendererWorkspaceBridge {
  private cdpBaseUrl: string | null = null;

  constructor(private readonly getWindow: () => WindowWithRendererRpc) {}

  setCdpBaseUrl(url: string | null): void {
    this.cdpBaseUrl = url;
  }

  async getSummary(): Promise<AppSummary> {
    return this.getRequestProxy()["workspace.summary"](undefined);
  }

  async openPane(params: PaneOpenParams): Promise<PaneResult> {
    return this.getRequestProxy()["workspace.open"](params);
  }

  async focusPane(params: PaneFocusParams): Promise<PaneResult> {
    return this.getRequestProxy()["workspace.focus"](params);
  }

  async closePane(params: PaneCloseParams): Promise<PaneResult> {
    return this.getRequestProxy()["workspace.close"](params);
  }

  async splitPane(params: PaneSplitParams): Promise<PaneResult> {
    return this.getRequestProxy()["workspace.split"](params);
  }

  async openTab(params: TabOpenParams): Promise<TabResult> {
    return this.getRequestProxy()["workspace.tab.open"](params);
  }

  async listTabs(): Promise<TabListResult> {
    return this.getRequestProxy()["workspace.tab.list"](undefined);
  }

  async focusTab(params: TabFocusParams): Promise<TabResult> {
    return this.getRequestProxy()["workspace.tab.focus"](params);
  }

  async closeTab(params: TabCloseParams): Promise<TabResult> {
    return this.getRequestProxy()["workspace.tab.close"](params);
  }

  async sendPaneMessage(params: PaneMessageParams): Promise<PaneMessageResult> {
    return this.getRequestProxy()["workspace.pane.message"](params);
  }

  async getBrowserTargets(): Promise<BrowserTargetsResult> {
    if (!this.cdpBaseUrl) {
      return { ok: true, cdpBaseUrl: null, targets: [] };
    }

    try {
      const response = await fetch(`${this.cdpBaseUrl}/json/list`);
      const raw = (await response.json()) as Array<Record<string, string>>;
      const targets: BrowserTarget[] = raw
        .filter((t) => t.type === "page")
        .map((t) => ({
          id: t.id ?? "",
          title: t.title ?? "",
          url: t.url ?? "",
          type: t.type ?? "",
          webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? ""
        }));

      return { ok: true, cdpBaseUrl: this.cdpBaseUrl, targets };
    } catch {
      return { ok: true, cdpBaseUrl: this.cdpBaseUrl, targets: [] };
    }
  }

  private getRequestProxy(): RendererRpcRequestProxy {
    const rpc = this.getWindow().webview.rpc as { request?: RendererRpcRequestProxy } | undefined;
    if (!rpc) {
      throw new Error("Renderer RPC is not ready");
    }

    if (!rpc.request) {
      throw new Error("Renderer request proxy is not ready");
    }

    return rpc.request;
  }
}
