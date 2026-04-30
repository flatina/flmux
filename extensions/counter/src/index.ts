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

// Single pane that exercises both scopes:
//   - app    → server-held count (shared across every workspace in the process)
//   - workspace → `ctx.workspaceStatus` retained KV (shared across panes in
//                 this workspace, isolated from other workspaces)
class CounterPane implements ExtensionPaneInstance {
  private readonly rpc = defineWebviewRpc<CounterSchema>({
    handlers: {
      messages: {
        "count.changed": ({ count }) => this.renderApp(count)
      }
    }
  });
  private dom: PanelDom | null = null;
  private disposed = false;
  private unsubscribeWorkspace?: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly ctx: ExtensionPaneContext
  ) {
    this.host.classList.add("counter-panel");
    ensureStylesheet(STYLESHEET_ID, panelStylesheetUrl);
    void this.mount();
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeWorkspace?.();
    this.rpc.dispose();
  }

  private async mount() {
    this.dom = await mountPanelShell(this.host, panelTemplateUrl, this.ctx);
    if (this.disposed || !this.dom) return;
    this.wireApp(this.dom.app);
    this.wireWorkspace(this.dom.workspace);
  }

  private async wireApp(dom: ScopeDom) {
    if (!this.ctx.rpcChannel) {
      dom.valueEl.textContent = "(server entry not wired)";
      return;
    }
    // Bind first; the server pushes the current count via `count.changed` on
    // connect, so the initial render arrives through the message listener.
    try {
      await this.ctx.rpcChannel.bindTo(this.rpc);
      if (this.disposed) return;
      dom.inc.addEventListener("click", () => this.applyApp(this.rpc.requestProxy.increment({ delta: 1 })));
      dom.dec.addEventListener("click", () => this.applyApp(this.rpc.requestProxy.increment({ delta: -1 })));
      dom.reset.addEventListener("click", () => this.applyApp(this.rpc.requestProxy.reset()));
    } catch (error) {
      console.warn("[counter] channel handshake failed", error);
      if (!this.disposed) dom.valueEl.textContent = "(handshake failed)";
    }
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

export default defineExtension({ panes: [counterPane] });
