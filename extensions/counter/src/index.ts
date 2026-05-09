import { defineWebviewRpc } from "bunite-core/view";
import {
  defineExtension,
  definePane,
  type ExtensionPaneContext,
  type ExtensionPaneInstance
} from "@flmux/extension-api";
import { type PanelDom, type ScopeDom, ensureStylesheet, mountPanelShell } from "./helpers";
import type { CounterSchema } from "./schema";

const panelTemplateUrl = new URL("./panel.html", import.meta.url).href;
const panelStylesheetUrl = new URL("./panel.css", import.meta.url).href;
const STYLESHEET_ID = "counter-panel-styles";
const WORKSPACE_STATUS_KEY = "count";

// Canonical "extension RPC + connected state" pattern. `sharedRpc` is set
// only AFTER `bindTo` resolves — so `sharedRpc !== null` means truly ready.
// `ready` exposes the wait-handle for any code that runs before bind
// completes (e.g. late-mounting panes). `latestCount` caches the most recent
// server push so panes mounting after `onLoad`'s one-shot push still render.
type CounterWebviewRpc = ReturnType<typeof defineWebviewRpc<CounterSchema>>;
let sharedRpc: CounterWebviewRpc | null = null;
let ready: Promise<void> | null = null;
let latestCount: number | null = null;
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
    if (this.disposed || !this.dom) return;
    // Render cached value immediately so a late mount doesn't sit blank
    // until the next mutation. `count.changed` was a one-shot push from
    // `onClientConnected` and may have already arrived.
    if (latestCount !== null) this.renderApp(latestCount);
    this.wireWorkspace(this.dom.workspace);
    // Wait for handshake before wiring app-scope click handlers — sends
    // before HELLO are silently dropped by the demuxer.
    await ready;
    if (this.disposed || !this.dom) return;
    this.wireApp(this.dom.app);
  }

  private wireApp(dom: ScopeDom) {
    if (!sharedRpc) {
      dom.valueEl.textContent = "(server entry not wired)";
      return;
    }
    const rpc = sharedRpc;
    dom.inc.addEventListener("click", () => this.applyApp(rpc.requestProxy.increment({ delta: 1 })));
    dom.dec.addEventListener("click", () => this.applyApp(rpc.requestProxy.increment({ delta: -1 })));
    dom.reset.addEventListener("click", () => this.applyApp(rpc.requestProxy.reset()));
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

const counterPane = definePane({
  kind: "counter",
  mount: (host, ctx) => new CounterPane(host, ctx),
  getTitle: ({ input }) => input.title?.trim() || "Counter"
});

export default defineExtension({
  panes: [counterPane],
  async onLoad(ctx) {
    const rpc = defineWebviewRpc<CounterSchema>({
      handlers: {
        messages: {
          "count.changed": ({ count }) => {
            latestCount = count;
            for (const render of paneRenderers.values()) render(count);
          }
        }
      }
    });
    ready = ctx.channel().bindTo(rpc);
    await ready;
    sharedRpc = rpc;
  }
});
