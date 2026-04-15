import type { ExtensionPaneContext, ExtensionPaneInstance } from "@flmux/extension-api";

interface ScratchpadParams extends Record<string, unknown> {
  note?: string;
}

export class ScratchpadPaneRenderer implements ExtensionPaneInstance {
  private note = "";
  private textarea?: HTMLTextAreaElement;
  private counterEl?: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ExtensionPaneContext
  ) {
    this.host.className = "scratchpad-panel";
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

export function normalizeScratchpadText(value: unknown) {
  return typeof value === "string" ? value : "";
}
