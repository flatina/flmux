import { addDisposableListener } from "dockview-core/dist/esm/events";
import { DefaultTab } from "dockview-core/dist/esm/dockview/components/tab/defaultTab";
import type { HeaderAction } from "../shared/extension-spi";

type DisposableLike = { dispose(): void };

export type PaneTabMenuModel = {
  icon: string;
  label: string;
  actions: HeaderAction[];
};

export type PaneTabMenuProvider = (panelId: string) => PaneTabMenuModel;

export class PaneTabRenderer extends DefaultTab {
  private panelId = "";
  private readonly menuWrapper = document.createElement("div");
  private readonly menuButton = document.createElement("div");
  private readonly panelDisposables: DisposableLike[] = [];
  private popupMenu: HTMLDivElement | null = null;
  private closePanel: (() => void) | null = null;

  constructor(private readonly getMenuModel: PaneTabMenuProvider) {
    super();

    this.menuWrapper.className = "pane-tab-menu-wrapper";
    this.menuButton.className = "dv-default-tab-action pane-tab-menu-btn";

    this.menuWrapper.append(this.menuButton);
    this.element.insertBefore(this.menuWrapper, this.element.firstChild);
  }

  override init(parameters: any): void {
    super.init(parameters);
    this.panelId = parameters.api.id;
    this.closePanel = () => parameters.api.close();

    this.panelDisposables.push(
      addDisposableListener(this.menuButton, "pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }),
      addDisposableListener(this.menuButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.togglePopup();
      })
    );

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.menuWrapper.contains(target) || this.popupMenu?.contains(target))) {
        return;
      }
      this.closePopup();
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    this.panelDisposables.push({
      dispose: () => document.removeEventListener("pointerdown", handleDocumentPointerDown)
    });

    this.refreshActions();
  }

  refreshActions(): void {
    const model = this.getMenuModel(this.panelId);
    this.menuButton.textContent = model.icon;
    this.menuButton.title = model.label;
    if (this.popupMenu) {
      this.renderPopupContents();
    }
  }

  private togglePopup(): void {
    if (this.popupMenu) {
      this.closePopup();
      return;
    }
    this.openPopup();
  }

  private openPopup(): void {
    const actions = this.getPopupActions();
    if (actions.length === 0) {
      return;
    }

    const popup = document.createElement("div");
    popup.className = "pane-tab-popup-menu";
    document.body.appendChild(popup);
    this.popupMenu = popup;
    this.renderPopupContents();

    const rect = this.menuButton.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(8, rect.right - 120)}px`;
  }

  private renderPopupContents(): void {
    if (!this.popupMenu) {
      return;
    }

    const actions = this.getPopupActions();
    this.popupMenu.replaceChildren();
    for (const action of actions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pane-tab-menu-item";
      item.textContent = action.icon;
      item.title = action.tooltip ?? "";
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePopup();
        action.onClick();
      });
      this.popupMenu.append(item);
    }
  }

  private getPopupActions(): HeaderAction[] {
    const model = this.getMenuModel(this.panelId);
    const actions = [...model.actions];
    if (this.closePanel) {
      actions.push({
        id: "close",
        icon: "Close",
        tooltip: "Close",
        onClick: () => this.closePanel?.()
      });
    }
    return actions;
  }

  private closePopup(): void {
    this.popupMenu?.remove();
    this.popupMenu = null;
  }

  override dispose(): void {
    this.closePopup();
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables.length = 0;
    super.dispose();
  }
}
