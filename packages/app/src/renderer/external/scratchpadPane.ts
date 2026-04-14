import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { ExternalPaneContext } from "./runtime";

interface ScratchpadParams extends Record<string, unknown> {
  note?: string;
}

export class ScratchpadPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private note = "";
  private textarea?: HTMLTextAreaElement;
  private counterEl?: HTMLElement;

  constructor(private readonly context: ExternalPaneContext) {
    this.element.className = "scratchpad-panel";
  }

  init(_params: GroupPanelPartInitParameters) {
    this.element.innerHTML = `
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

    this.textarea = this.element.querySelector<HTMLTextAreaElement>('[data-role="textarea"]')!;
    this.counterEl = this.element.querySelector<HTMLElement>('[data-role="counter"]')!;
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

    this.element.querySelector<HTMLButtonElement>('[data-action="clear"]')!.addEventListener("click", () => {
      this.note = "";
      this.textarea!.value = "";
      this.context.state.setParams({
        note: ""
      });
      this.renderCounter();
    });
  }

  update(_event: PanelUpdateEvent<Record<string, unknown>>) {
    this.note = normalizeScratchpadText(this.context.state.getParams<ScratchpadParams>().note);
    if (this.textarea) {
      this.textarea.value = this.note;
    }
    this.renderCounter();
  }

  private renderCounter() {
    this.counterEl!.textContent = `${this.note.length} chars`;
  }
}

export function normalizeScratchpadText(value: unknown) {
  return typeof value === "string" ? value : "";
}
