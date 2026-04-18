import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview-core";

export class PlaceholderPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  constructor() {
    this.element.className = "placeholder-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    const input = (params.params ?? {}) as { originalKind?: unknown; error?: unknown };
    const originalKind = typeof input.originalKind === "string" ? input.originalKind : "unknown";
    const error = typeof input.error === "string" ? input.error : "Pane kind not registered";

    const title = document.createElement("div");
    title.className = "placeholder-panel__title";
    title.textContent = `Missing: ${originalKind}`;

    const message = document.createElement("div");
    message.className = "placeholder-panel__message";
    message.textContent = error;

    const hint = document.createElement("div");
    hint.className = "placeholder-panel__hint";
    hint.textContent = "Close this pane to dismiss.";

    this.element.replaceChildren(title, message, hint);
  }
}
