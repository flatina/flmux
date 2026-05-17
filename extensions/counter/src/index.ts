import { bootstrap } from "bunite-core/rpc/renderer";
import type { ClientOf } from "bunite-core/rpc";
import {
  defineExtension,
  definePaneRenderer,
  type ExtensionPaneContext,
  type ExtensionPaneInstance
} from "@flmux/extension-api";
import { type PanelDom, type ScopeDom, ensureStylesheet, mountPanelShell } from "./helpers";
import { counterCap } from "./schema";

const panelTemplateUrl = new URL("./panel.html", import.meta.url).href;
const panelStylesheetUrl = new URL("./panel.css", import.meta.url).href;
const STYLESHEET_ID = "counter-panel-styles";
const WORKSPACE_STATUS_KEY = "count";

type CounterClient = ClientOf<typeof counterCap>;

// SessionCap-pure: ext cap is served per session by the host's onSession.
// The renderer bootstraps it inside `onLoad` (post-createSession on this
// connection), then stores the client for every pane mount.
let counterReady: Promise<CounterClient> | null = null;
const paneRenderers = new Map<string, (count: number) => void>();

class CounterPane implements ExtensionPaneInstance {
  private dom: PanelDom | null = null;
  private disposed = false;
  private unsubscribeWorkspace?: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly ctx: ExtensionPaneContext
  ) {
    this.host.classList.add("counter-panel");
    ensureStylesheet(STYLESHEET_ID, panelStylesheetUrl);
    paneRenderers.set(ctx.paneId, (count) => this.renderApp(count));
    void this.mount();
  }

  dispose() {
    this.disposed = true;
    paneRenderers.delete(this.ctx.paneId);
    this.unsubscribeWorkspace?.();
  }

  private async mount() {
    this.dom = await mountPanelShell(this.host, panelTemplateUrl, this.ctx);
    if (this.disposed || !this.dom || !counterReady) return;
    this.wireWorkspace(this.dom.workspace);
    const counter = await counterReady;
    if (this.disposed || !this.dom) return;
    this.wireApp(this.dom.app, counter);
    try {
      const { count } = await counter.getCount();
      if (this.disposed) return;
      this.renderApp(count);
    } catch (error) {
      console.warn("[counter] initial getCount failed", error);
    }
  }

  private wireApp(dom: ScopeDom, counter: CounterClient) {
    dom.inc.addEventListener("click", () => this.applyApp(counter.increment({ delta: 1 })));
    dom.dec.addEventListener("click", () => this.applyApp(counter.increment({ delta: -1 })));
    dom.reset.addEventListener("click", () => this.applyApp(counter.reset()));
  }

  private wireWorkspace(dom: ScopeDom) {
    dom.inc.addEventListener("click", () => this.bumpWorkspace((c) => c + 1));
    dom.dec.addEventListener("click", () => this.bumpWorkspace((c) => c - 1));
    dom.reset.addEventListener("click", () => this.writeWorkspace(0));
    this.unsubscribeWorkspace = this.ctx.workspaceStatus.subscribe<number>(WORKSPACE_STATUS_KEY, (value) => {
      this.renderWorkspace(value ?? 0);
    });
  }

  private async applyApp(promise: Promise<{ count: number }>) {
    try {
      const { count } = await promise;
      this.renderApp(count);
    } catch (error) {
      console.warn("[counter] rpc failed", error);
    }
  }

  private bumpWorkspace(transform: (current: number) => number) {
    const current = this.ctx.workspaceStatus.get<number>(WORKSPACE_STATUS_KEY) ?? 0;
    this.writeWorkspace(transform(current));
  }

  private writeWorkspace(next: number) {
    this.ctx.workspaceStatus.set(WORKSPACE_STATUS_KEY, next);
  }

  private renderApp(count: number) {
    if (this.disposed || !this.dom) return;
    this.dom.app.valueEl.textContent = String(count);
  }

  private renderWorkspace(count: number) {
    if (this.disposed || !this.dom) return;
    this.dom.workspace.valueEl.textContent = String(count);
  }
}

export default defineExtension({
  panes: [definePaneRenderer({ kind: "counter", mount: (host, ctx) => new CounterPane(host, ctx) })],
  onLoad() {
    counterReady = bootstrap(counterCap);
    void (async () => {
      try {
        const counter = await counterReady!;
        for await (const event of counter.changed()) {
          for (const render of paneRenderers.values()) render(event.count);
        }
      } catch (error) {
        console.warn("[counter] changed stream ended", error);
      }
    })();
  }
});
