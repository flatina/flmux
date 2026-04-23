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

class CounterPane implements ExtensionPaneInstance {
  private readonly rpc = defineWebviewRPC<CounterSchema>({
    handlers: {
      messages: {
        "count.changed": ({ count }) => this.render(count)
      }
    }
  });
  private readonly valueEl: HTMLElement;
  private disposed = false;

  constructor(host: HTMLElement, ctx: ExtensionPaneContext) {
    host.className = "counter-panel";
    host.innerHTML = `
      <section class="counter-hero">
        <div>
          <strong>counter</strong>
          <p>Server-held count shared across every pane over its own RPC channel.</p>
        </div>
        <div class="counter-identities">
          <span data-role="workspace-id">${ctx.workspaceId}</span>
          <span data-role="pane-id">${ctx.paneId}</span>
        </div>
      </section>
      <section class="counter-card">
        <div class="counter-value" data-role="value">--</div>
        <div class="counter-actions">
          <button type="button" data-action="dec">-1</button>
          <button type="button" data-action="reset">reset</button>
          <button type="button" data-action="inc">+1</button>
        </div>
      </section>
    `;
    this.valueEl = host.querySelector<HTMLElement>('[data-role="value"]')!;

    if (!ctx.channel) {
      this.valueEl.textContent = "(server entry not wired)";
      return;
    }

    const inc = host.querySelector<HTMLButtonElement>('[data-action="inc"]')!;
    const dec = host.querySelector<HTMLButtonElement>('[data-action="dec"]')!;
    const reset = host.querySelector<HTMLButtonElement>('[data-action="reset"]')!;

    // Await the channel handshake before wiring anything that sends a
    // request — the server publishes the current count via `count.changed`
    // as soon as it sees us, so the initial render arrives through the
    // message listener, not a round-trip.
    ctx.channel
      .bindTo(this.rpc)
      .then(() => {
        if (this.disposed) return;
        inc.addEventListener("click", () => this.apply(this.rpc.requestProxy.increment({ delta: 1 })));
        dec.addEventListener("click", () => this.apply(this.rpc.requestProxy.increment({ delta: -1 })));
        reset.addEventListener("click", () => this.apply(this.rpc.requestProxy.reset()));
      })
      .catch((error) => {
        console.warn("[counter] channel handshake failed", error);
        if (!this.disposed) this.valueEl.textContent = "(handshake failed)";
      });
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
    if (this.disposed) return;
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
