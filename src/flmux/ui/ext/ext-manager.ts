import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { HostRpc } from "../../rpc/host-rpc";

export const EXT_MANAGER_COMPONENT = "ext-manager";
export const EXT_MANAGER_TAB_ID = "ext-manager.singleton";

interface ExtEntry {
  id: string;
  name: string;
  version: string;
  embedded: boolean;
  disabled: boolean;
}

export class ExtManagerRenderer implements IContentRenderer {
  readonly element = document.createElement("div");
  private list = document.createElement("div");
  private banner = document.createElement("div");
  private dirty = false;

  constructor(private readonly hostRpc: HostRpc) {
    this.element.className = "ext-manager";
  }

  init(_params: GroupPanelPartInitParameters): void {
    this.banner.className = "ext-manager-banner";
    this.banner.hidden = true;
    this.banner.textContent = "Changes take effect after restart.";

    const header = document.createElement("div");
    header.className = "ext-manager-header";
    header.textContent = "Extensions";

    this.list.className = "ext-manager-list";
    this.element.append(header, this.banner, this.list);

    void this.load();
  }

  update(_event: PanelUpdateEvent): void {}

  dispose(): void {
    this.element.replaceChildren();
  }

  private async load(): Promise<void> {
    const result = await this.hostRpc.request("extension.listAll", undefined);
    this.renderList(result.extensions);
  }

  private renderList(extensions: ExtEntry[]): void {
    this.list.replaceChildren();

    if (extensions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ext-manager-empty";
      empty.textContent = "No extensions installed";
      this.list.append(empty);
      return;
    }

    for (const ext of extensions) {
      this.list.append(this.buildEntry(ext));
    }
  }

  private buildEntry(ext: ExtEntry): HTMLElement {
    const entry = document.createElement("div");
    entry.className = `ext-manager-entry${ext.disabled ? " ext-disabled" : ""}`;

    const icon = document.createElement("span");
    icon.className = "ext-manager-icon";
    icon.textContent = "\u{1F9E9}";

    const info = document.createElement("div");
    info.className = "ext-manager-info";

    const name = document.createElement("div");
    name.className = "ext-manager-name";
    name.textContent = ext.name;
    if (ext.disabled) name.textContent += " (disabled)";

    const meta = document.createElement("div");
    meta.className = "ext-manager-meta";
    meta.textContent = `${ext.id} v${ext.version}${ext.embedded ? " \u00B7 built-in" : ""}`;

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "ext-manager-actions";

    // Enable/Disable toggle
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ext-manager-btn";
    toggleBtn.textContent = ext.disabled ? "Enable" : "Disable";
    toggleBtn.addEventListener("click", () => {
      const method = ext.disabled ? "extension.enable" : "extension.disable";
      this.setButtonsDisabled(actions, true);
      void this.hostRpc
        .request(method, { extensionId: ext.id })
        .then(() => {
          this.showBanner();
          void this.load();
        })
        .catch(() => this.setButtonsDisabled(actions, false));
    });
    actions.append(toggleBtn);

    // Uninstall (only for non-embedded)
    if (!ext.embedded) {
      const uninstallBtn = document.createElement("button");
      uninstallBtn.type = "button";
      uninstallBtn.className = "ext-manager-btn ext-manager-btn-danger";
      uninstallBtn.textContent = "Uninstall";
      uninstallBtn.addEventListener("click", () => {
        if (!confirm(`Uninstall "${ext.name}"?`)) return;
        this.setButtonsDisabled(actions, true);
        void this.hostRpc
          .request("extension.uninstall", { extensionId: ext.id })
          .then((res) => {
            if (!res.ok) {
              alert("error" in res ? res.error : "Uninstall failed");
              this.setButtonsDisabled(actions, false);
            } else {
              this.showBanner();
              void this.load();
            }
          })
          .catch(() => this.setButtonsDisabled(actions, false));
      });
      actions.append(uninstallBtn);
    }

    entry.append(icon, info, actions);
    return entry;
  }

  private setButtonsDisabled(container: HTMLElement, disabled: boolean): void {
    for (const btn of container.querySelectorAll("button")) {
      (btn as HTMLButtonElement).disabled = disabled;
    }
  }

  private showBanner(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.banner.hidden = false;
  }
}
