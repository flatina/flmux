// Import from the thin `shared/rpc` subpath — `bunite-core/view` pulls in the
// webview polyfill which touches `window` at module load, breaking the
// main-side `import()` that flmux performs to extract pane definitions.
import { defineWebviewRPC } from "bunite-core/shared/rpc";
import {
  defineExtension,
  definePane,
  type ExtensionPaneContext,
  type ExtensionPaneInstance
} from "@flmux/extension-api";
import type { CounterSchema } from "./schema";

const panelTemplateUrl = new URL("./panel.html", import.meta.url).href;

class CounterPane implements ExtensionPaneInstance {
  private readonly rpc = defineWebviewRPC<CounterSchema>({
    handlers: {
      messages: {
        "count.changed": ({ count }) => this.render(count)
      }
    }
  });
  private valueEl: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly ctx: ExtensionPaneContext
  ) {
    this.host.className = "counter-panel";
    void this.mount();
  }

  private async mount() {
    let html: string;
    try {
      html = await fetch(panelTemplateUrl).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
    } catch (error) {
      console.warn("[counter] panel template fetch failed", error);
      if (!this.disposed) this.host.textContent = "(panel template failed to load)";
      return;
    }
    if (this.disposed) return;

    this.host.innerHTML = html;
    this.host.querySelector<HTMLElement>('[data-role="workspace-id"]')!.textContent = this.ctx.workspaceId;
    this.host.querySelector<HTMLElement>('[data-role="pane-id"]')!.textContent = this.ctx.paneId;
    this.valueEl = this.host.querySelector<HTMLElement>('[data-role="value"]');

    if (!this.ctx.channel) {
      if (this.valueEl) this.valueEl.textContent = "(server entry not wired)";
      return;
    }

    const inc = this.host.querySelector<HTMLButtonElement>('[data-action="inc"]')!;
    const dec = this.host.querySelector<HTMLButtonElement>('[data-action="dec"]')!;
    const reset = this.host.querySelector<HTMLButtonElement>('[data-action="reset"]')!;

    // Await the channel handshake before wiring anything that sends a
    // request — the server publishes the current count via `count.changed`
    // as soon as it sees us, so the initial render arrives through the
    // message listener, not a round-trip.
    try {
      await this.ctx.channel.bindTo(this.rpc);
      if (this.disposed) return;
      inc.addEventListener("click", () => this.apply(this.rpc.requestProxy.increment({ delta: 1 })));
      dec.addEventListener("click", () => this.apply(this.rpc.requestProxy.increment({ delta: -1 })));
      reset.addEventListener("click", () => this.apply(this.rpc.requestProxy.reset()));
    } catch (error) {
      console.warn("[counter] channel handshake failed", error);
      if (!this.disposed && this.valueEl) this.valueEl.textContent = "(handshake failed)";
    }
  }

  private async apply(promise: Promise<{ count: number }>) {
    try {
      const { count } = await promise;
      this.render(count);
    } catch (error) {
      console.warn("[counter] rpc failed", error);
    }
  }

  private render(count: number) {
    if (this.disposed || !this.valueEl) return;
    this.valueEl.textContent = String(count);
  }

  dispose() {
    this.disposed = true;
    this.rpc.dispose();
  }
}

const counterPane = definePane({
  kind: "counter",
  mount: (host, ctx) => new CounterPane(host, ctx),
  getTitle: ({ input }) => input.title?.trim() || "Counter"
});

export default defineExtension({ panes: [counterPane] });
