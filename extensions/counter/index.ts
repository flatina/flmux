import type { ExtensionPaneContext, ExtensionPaneInstance } from "@flmux/extension-api";
import { defineExtension, definePane } from "@flmux/extension-api";

interface CounterParams extends Record<string, unknown> {
  count?: number;
}

class CounterPaneRenderer implements ExtensionPaneInstance {
  private count = 0;
  private valueEl?: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ExtensionPaneContext
  ) {
    this.host.className = "counter-panel";
    this.mount();
  }

  update(params?: Record<string, unknown>) {
    const next = (params ?? this.context.state.getParams<CounterParams>()) as CounterParams;
    this.count = normalizeCount(next.count);
    this.render();
  }

  private mount() {
    this.host.innerHTML = `
      <section class="counter-hero">
        <div>
          <strong>counter</strong>
          <p>Number-state pane with +/- buttons and writable pathMount.</p>
        </div>
        <div class="counter-identities">
          <span data-role="workspace-id">${this.context.workspaceId}</span>
          <span data-role="pane-id">${this.context.paneId}</span>
        </div>
      </section>
      <section class="counter-card">
        <div class="counter-value" data-role="value">0</div>
        <div class="counter-actions">
          <button type="button" data-action="dec">-1</button>
          <button type="button" data-action="reset">reset</button>
          <button type="button" data-action="inc">+1</button>
        </div>
      </section>
    `;

    this.valueEl = this.host.querySelector<HTMLElement>('[data-role="value"]')!;
    this.count = normalizeCount(this.context.state.getParams<CounterParams>().count);
    this.render();

    const setCount = (next: number) => {
      this.count = next;
      this.context.state.setParams({ count: this.count });
      this.render();
    };

    this.host.querySelector<HTMLButtonElement>('[data-action="dec"]')!.addEventListener("click", () => setCount(this.count - 1));
    this.host.querySelector<HTMLButtonElement>('[data-action="inc"]')!.addEventListener("click", () => setCount(this.count + 1));
    this.host.querySelector<HTMLButtonElement>('[data-action="reset"]')!.addEventListener("click", () => setCount(0));
  }

  private render() {
    if (this.valueEl) {
      this.valueEl.textContent = String(this.count);
    }
  }
}

const counterPane = definePane({
  kind: "counter",
  mount: (host, context) => new CounterPaneRenderer(host, context),
  createParams: ({ input }) => ({
    count: normalizeCount(input.params?.count)
  }),
  getTitle: ({ input }) => input.title?.trim() || "Counter",
  normalizeRestoredParams: ({ params }) => ({
    count: normalizeCount(params?.count)
  }),
  serializeParams: ({ currentParams }) => ({
    count: normalizeCount(currentParams?.count)
  }),
  pathMount: {
    mountKey: "counter",
    getStateSnapshot: ({ currentParams }) => ({
      count: normalizeCount(currentParams?.count)
    }),
    canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "count",
    setState: async ({ relativePath, value, setParams }) => {
      if (relativePath.length !== 1 || relativePath[0] !== "count") {
        throw new Error(`Unsupported counter path '${relativePath.join("/")}'`);
      }

      const count = normalizeCount(value);
      await setParams({ count });
      return { value: count };
    },
    getStatusSnapshot: ({ currentParams }) => ({
      count: normalizeCount(currentParams?.count)
    })
  }
});

export default defineExtension({
  panes: [counterPane]
});

function normalizeCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}
