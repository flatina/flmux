import type { ExtensionPaneContext, ExtensionPaneInstance } from "@flmux/extension-api";
import { defineExtension, definePane } from "@flmux/extension-api";

const panelStylesheetUrl = new URL("./panel.css", import.meta.url).href;
const STYLESHEET_ID = "scratchpad-panel-styles";

function ensureStylesheet() {
  if (document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = panelStylesheetUrl;
  document.head.appendChild(link);
}

interface ScratchpadParams extends Record<string, unknown> {
  note?: string;
}

class ScratchpadPaneRenderer implements ExtensionPaneInstance {
  private note = "";
  private textarea?: HTMLTextAreaElement;
  private counterEl?: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ExtensionPaneContext
  ) {
    this.host.classList.add("scratchpad-panel");
    ensureStylesheet();
    this.mount();
  }

  update(params?: Record<string, unknown>) {
    const nextParams = (params ?? this.context.state.getParams<ScratchpadParams>()) as ScratchpadParams;
    this.note = normalizeScratchpadText(nextParams.note);
    if (this.textarea) {
      this.textarea.value = this.note;
    }
    this.renderCounter();
  }

  private mount() {
    this.host.innerHTML = `
      <section class="scratchpad-hero">
        <div>
          <strong>scratchpad</strong>
          <p>Stateful external pane using external params persistence only.</p>
        </div>
        <div class="scratchpad-identities">
          <span data-role="workspace-id">${this.context.workspaceId}</span>
          <span data-role="pane-id">${this.context.paneId}</span>
        </div>
      </section>
      <section class="scratchpad-card">
        <header class="scratchpad-card__header">
          <strong>Note</strong>
          <span>Saved into pane params for session restore.</span>
        </header>
        <textarea class="scratchpad-textarea" data-role="textarea" spellcheck="false" placeholder="write anything..."></textarea>
        <div class="scratchpad-footer">
          <span data-role="counter">0 chars</span>
          <button type="button" data-action="clear">Clear</button>
        </div>
      </section>
    `;

    this.textarea = this.host.querySelector<HTMLTextAreaElement>('[data-role="textarea"]')!;
    this.counterEl = this.host.querySelector<HTMLElement>('[data-role="counter"]')!;
    this.note = normalizeScratchpadText(this.context.state.getParams<ScratchpadParams>().note);
    this.textarea.value = this.note;
    this.renderCounter();

    this.textarea.addEventListener("input", () => {
      this.note = this.textarea!.value;
      this.context.state.setParams({
        note: this.note
      });
      this.renderCounter();
    });

    this.host.querySelector<HTMLButtonElement>('[data-action="clear"]')!.addEventListener("click", () => {
      this.note = "";
      this.textarea!.value = "";
      this.context.state.setParams({
        note: ""
      });
      this.renderCounter();
    });
  }

  private renderCounter() {
    this.counterEl!.textContent = `${this.note.length} chars`;
  }
}

const scratchpadPane = definePane({
  kind: "scratchpad",
  mount: (host, context) => new ScratchpadPaneRenderer(host, context),
  createParams: ({ input }) => ({
    note: normalizeScratchpadText(input.params?.note)
  }),
  getTitle: ({ input }) => input.title?.trim() || "Scratchpad",
  normalizeRestoredParams: ({ params }) => ({
    note: normalizeScratchpadText(params?.note)
  }),
  serializeParams: ({ currentParams }) => ({
    note: normalizeScratchpadText(currentParams?.note)
  }),
  pathMount: {
    mountKey: "scratchpad",
    getStateSnapshot: ({ currentParams }) => {
      const note = normalizeScratchpadText(currentParams?.note);
      return { note };
    },
    canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "note",
    setState: async ({ relativePath, value, setParams }) => {
      if (relativePath.length !== 1 || relativePath[0] !== "note") {
        throw new Error(`Unsupported scratchpad path '${relativePath.join("/")}'`);
      }

      const note = normalizeScratchpadText(value);
      await setParams({ note });
      return { value: note };
    },
    // Two illustrative callState shapes:
    //   - `stats` is a pure read (args ignored, no state mutation) — the
    //     query pattern external agents use when they want a computed answer
    //     without caring about the underlying snapshot shape.
    //   - `clear` mutates state via patchParams and returns a confirmation —
    //     the action pattern equivalent to an RPC verb like `reset`.
    canCallStatePath: ({ relativePath }) =>
      relativePath.length === 1 && (relativePath[0] === "stats" || relativePath[0] === "clear"),
    callState: async ({ relativePath, currentParams, patchParams }) => {
      const op = relativePath[0];
      if (op === "stats") {
        const note = normalizeScratchpadText(currentParams?.note);
        return {
          value: {
            chars: note.length,
            words: note.trim() === "" ? 0 : note.trim().split(/\s+/).length,
            lines: note === "" ? 0 : note.split(/\r?\n/).length
          }
        };
      }
      if (op === "clear") {
        await patchParams({ note: "" });
        return { value: { cleared: true } };
      }
      throw new Error(`Unsupported scratchpad op '${op}'`);
    },
    getStatusSnapshot: ({ currentParams }) => {
      const note = normalizeScratchpadText(currentParams?.note);
      return {
        noteLength: note.length
      };
    }
  }
});

export default defineExtension({
  panes: [scratchpadPane]
});

function normalizeScratchpadText(value: unknown) {
  return typeof value === "string" ? value : "";
}
