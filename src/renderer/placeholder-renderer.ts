import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";

export class PlaceholderRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  constructor(private readonly extensionId: string) {
    this.element.className = "placeholder-pane";
  }

  init(_params: GroupPanelPartInitParameters): void {
    const wrapper = document.createElement("div");
    wrapper.className = "placeholder-content";

    const icon = document.createElement("div");
    icon.className = "placeholder-icon";
    icon.textContent = "\u{1F6AB}";

    const title = document.createElement("div");
    title.className = "placeholder-title";
    title.textContent = "Extension not available";

    const message = document.createElement("div");
    message.className = "placeholder-message";
    message.textContent = `"${this.extensionId}" may have been disabled or uninstalled.`;

    wrapper.append(icon, title, message);
    this.element.replaceChildren(wrapper);
  }

  update(_event: PanelUpdateEvent): void {}

  dispose(): void {
    this.element.replaceChildren();
  }
}
