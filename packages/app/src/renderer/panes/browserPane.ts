import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { SurfaceEvent } from "bunite-core/rpc";
import {
  type BuniteWebviewAutomationElement,
  registerBrowserPaneElement,
  unregisterBrowserPaneElement
} from "./browserPaneRegistry";

interface BrowserPaneRendererDependencies {
  panelTemplate: HTMLTemplateElement;
  normalizeUrl(value: string): string | null;
  onUrlChange(paneId: string, url: string): void;
}

type BrowserPaneParams = {
  url?: string;
};

// `<bunite-webview>` element surface — `BuniteWebviewAutomationElement`
// owns the full automation type, plus the few DOM-side helpers this pane
// renderer calls directly (navigate via attribute, history nav).
type BrowserViewElement = BuniteWebviewAutomationElement & {
  navigate(url: string): void;
};

export class BrowserPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private paneId = "";
  private currentUrl = "";
  private urlInput?: HTMLInputElement;
  private webview?: BrowserViewElement;

  constructor(private readonly deps: BrowserPaneRendererDependencies) {
    this.element.className = "browser-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    this.paneId = params.api.id;
    this.element.replaceChildren(this.deps.panelTemplate.content.cloneNode(true));

    this.urlInput = this.element.querySelector<HTMLInputElement>(".browser-nav__url")!;
    this.webview = this.element.querySelector("bunite-webview")! as BrowserViewElement;
    registerBrowserPaneElement(this.paneId, this.webview);

    this.currentUrl = (params.params as BrowserPaneParams).url ?? "";
    this.urlInput.value = this.currentUrl;
    if (this.currentUrl) {
      this.webview.setAttribute("src", this.currentUrl);
    }

    this.element.querySelector<HTMLElement>('[data-action="back"]')!.addEventListener("click", () => {
      this.webview?.goBack();
    });

    this.element.querySelector<HTMLElement>('[data-action="reload"]')!.addEventListener("click", () => {
      this.webview?.reload();
    });

    this.urlInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }

      const nextUrl = this.deps.normalizeUrl(this.urlInput!.value);
      if (!nextUrl) {
        return;
      }

      this.navigateTo(nextUrl);
    });

    this.webview.addEventListener("surface-event", ((event: CustomEvent<SurfaceEvent>) => {
      const detail = event.detail;
      if (detail.type === "navigate") {
        this.currentUrl = detail.url;
        if (this.urlInput) this.urlInput.value = this.currentUrl;
        this.deps.onUrlChange(this.paneId, this.currentUrl);
      } else if (detail.type === "load-fail") {
        console.warn(`[browser pane] blocked navigation to '${detail.url}' (${detail.reason ?? "unknown"})`);
        if (this.urlInput) this.urlInput.value = this.currentUrl;
      }
    }) as EventListener);
  }

  update(event: PanelUpdateEvent<BrowserPaneParams>) {
    const nextUrl = event.params.url;
    if (!nextUrl || nextUrl === this.currentUrl) {
      return;
    }

    this.navigateTo(nextUrl);
  }

  dispose() {
    if (this.paneId && this.webview) unregisterBrowserPaneElement(this.paneId, this.webview);
  }

  private navigateTo(url: string) {
    this.currentUrl = url;
    this.urlInput!.value = url;
    this.webview!.navigate(url);
    this.deps.onUrlChange(this.paneId, url);
  }
}
