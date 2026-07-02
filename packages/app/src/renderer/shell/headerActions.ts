import type {
  GroupPanelPartInitParameters,
  IHeaderActionsRenderer,
  IGroupHeaderProps,
  IWatermarkRenderer,
  WatermarkRendererInitParameters,
  DockviewGroupPanel
} from "dockview-core";
import { DefaultTab } from "dockview-core";
import type { PaneHeaderMenu, PaneHeaderMenuItem } from "@flmux/extension-api";
import type { ShellModelAPI } from "@flmux/core/shell";
import type { FlmuxRendererBootstrapConfig } from "../../shared/rendererBridge";
import { renderAppTemplate } from "../../shared/appTemplate";
import { getPaneHeaderMenu } from "../external/paneTabMenuRegistry";
import { logout, openSettingsDialog } from "./settingsDialog";

type Disposer = () => void;

class HeaderActionButton {
  readonly element = document.createElement("div");
  protected readonly button = document.createElement("button");
  private disposers: Disposer[] = [];

  constructor(label: string, title: string) {
    this.element.className = "header-action";
    this.button.type = "button";
    this.button.className = "header-action__btn";
    this.button.textContent = label;
    this.button.title = title;
    this.element.append(this.button);
  }

  protected addDisposer(dispose: Disposer) {
    this.disposers.push(dispose);
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.element.replaceChildren();
  }
}

export class WorkspaceHeaderActions implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  private readonly menuButton = document.createElement("button");
  private popup: HTMLDivElement | null = null;
  private disposers: Array<() => void> = [];

  constructor(
    _group: DockviewGroupPanel,
    private readonly handlers: { onAdd: () => void; onResetActive: () => void },
    private readonly config: FlmuxRendererBootstrapConfig,
    private readonly shellModel: ShellModelAPI
  ) {
    this.element.className = "header-action";
    this.menuButton.type = "button";
    this.menuButton.className = "header-action__btn";
    this.menuButton.textContent = "☰";
    this.menuButton.title = "Workspace menu";
    this.element.append(this.menuButton);
  }

  init(_params: IGroupHeaderProps) {
    const toggleListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePopup();
    };
    const docPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.menuButton.contains(target) || this.popup?.contains(target))) return;
      this.closePopup();
    };

    this.menuButton.addEventListener("click", toggleListener);
    document.addEventListener("pointerdown", docPointerDown);
    this.disposers.push(
      () => this.menuButton.removeEventListener("click", toggleListener),
      () => document.removeEventListener("pointerdown", docPointerDown)
    );
  }

  private togglePopup() {
    if (this.popup) this.closePopup();
    else this.openPopup();
  }

  private openPopup() {
    const popup = document.createElement("div");
    popup.className = "header-action-popup";

    const addItem = (label: string, run: () => void) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "header-action-popup__item";
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePopup();
        run();
      });
      popup.append(item);
    };
    const addSeparator = () => {
      const separator = document.createElement("div");
      separator.className = "header-action-popup__sep";
      popup.append(separator);
    };

    const account = this.config.mode === "web" ? this.config.account : undefined;
    if (account) {
      addItem(`👤  ${account.displayName ?? account.name}`, () =>
        openSettingsDialog(this.config, this.shellModel, "account")
      );
    }
    addItem("⚙  Settings…", () => openSettingsDialog(this.config, this.shellModel, "appearance"));

    addSeparator();

    addItem("↻  Reset Workspace", () => this.handlers.onResetActive());
    addItem("+  New Workspace", () => this.handlers.onAdd());

    if (account) {
      addSeparator();
      addItem("⎋  Log out", () => void logout());
    }

    document.body.append(popup);
    this.popup = popup;
    positionMenuPopup(this.menuButton, popup, "end");
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  dispose() {
    this.closePopup();
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.element.replaceChildren();
  }
}

export interface PaneKindOption {
  kind: string;
  label: string;
  iconUrl?: string;
}

/** Place a popup against an anchor: below, flipping above when cramped, both
 *  axes clamped to the viewport. `align` pins its right ("end") or left ("start")
 *  edge to the anchor. Call after the popup is in the DOM (measures `offset*`). */
export function positionMenuPopup(anchor: HTMLElement, popup: HTMLElement, align: "start" | "end" = "end"): void {
  const margin = 4;
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = popup.offsetWidth;
  const h = popup.offsetHeight;

  let top = rect.bottom + margin;
  if (top + h > vh - margin && rect.top - margin - h >= margin) {
    top = rect.top - margin - h; // flip above
  }
  top = Math.max(margin, Math.min(top, vh - margin - h));

  let left = align === "end" ? rect.right - w : rect.left;
  left = Math.max(margin, Math.min(left, vw - margin - w));

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

/** Icon + label; shared by the popup rows and the watermark grid cards. */
export function fillKindButton(button: HTMLButtonElement, option: PaneKindOption, iconClass: string): void {
  button.type = "button";
  button.dataset.kind = option.kind;
  const icon = document.createElement("span");
  icon.className = iconClass;
  const img = document.createElement("img");
  img.src = option.iconUrl ?? "/__flmux/assets/pane.svg";
  img.alt = "";
  icon.append(img);
  const label = document.createElement("span");
  label.textContent = option.label;
  button.append(icon, label);
}

/**
 * Render the pane-kind popup anchored to a button (or any element).
 * Returns the popup so the caller can `remove()` it on close. Both the
 * inner `+` (NewPaneHeaderAction) and the outer hamburger (workspace tab)
 * use this so the menu shape stays in lock-step.
 */
export function openPaneKindPopup(
  anchor: HTMLElement,
  listKinds: () => PaneKindOption[],
  onSelect: (kind: string) => void,
  onClose: () => void
): HTMLDivElement {
  const kinds = listKinds();
  const popup = document.createElement("div");
  popup.className = "header-action-popup";

  if (kinds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "header-action-popup__empty";
    empty.textContent = "No pane kinds registered.";
    popup.append(empty);
  } else {
    for (const option of kinds) {
      const item = document.createElement("button");
      item.className = "header-action-popup__item";
      fillKindButton(item, option, "header-action-popup__icon");
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        onSelect(option.kind);
      });
      popup.append(item);
    }
  }

  document.body.append(popup);
  positionMenuPopup(anchor, popup, "end");

  return popup;
}

export class NewPaneHeaderAction extends HeaderActionButton implements IHeaderActionsRenderer {
  private popup: HTMLDivElement | null = null;

  constructor(
    _group: DockviewGroupPanel,
    private readonly options: {
      listKinds: () => PaneKindOption[];
      onSelect: (kind: string) => void;
    }
  ) {
    super("+", "New Pane");
  }

  init(_params: IGroupHeaderProps) {
    const clickListener = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePopup();
    };
    this.button.addEventListener("click", clickListener);
    this.addDisposer(() => this.button.removeEventListener("click", clickListener));

    const documentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.element.contains(target) || this.popup?.contains(target))) {
        return;
      }
      this.closePopup();
    };
    document.addEventListener("pointerdown", documentPointerDown);
    this.addDisposer(() => document.removeEventListener("pointerdown", documentPointerDown));
  }

  private togglePopup() {
    if (this.popup) {
      this.closePopup();
    } else {
      this.popup = openPaneKindPopup(this.button, this.options.listKinds, this.options.onSelect, () =>
        this.closePopup()
      );
    }
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  override dispose() {
    this.closePopup();
    super.dispose();
  }
}

export interface EmptyWorkspaceWatermarkOptions {
  listKinds: () => PaneKindOption[];
  onSelect: (kind: string) => void;
  appName: string;
  appVersion: string;
  watermarkHeader?: string;
  watermarkFooter: string;
}

/** Empty-workspace watermark: an inline pane-kind grid (header / grid / footer),
 *  the add-pane affordance when a workspace has no panes. */
export class EmptyWorkspaceWatermark implements IWatermarkRenderer {
  readonly element: HTMLElement;

  constructor(options: EmptyWorkspaceWatermarkOptions) {
    const vars = { appName: options.appName, appVersion: options.appVersion, host: window.location.host };
    this.element = document.createElement("div");
    this.element.className = "flmux-empty-watermark";

    if (options.watermarkHeader) {
      const header = document.createElement("div");
      header.className = "flmux-empty-watermark__header";
      header.textContent = renderAppTemplate(options.watermarkHeader, vars);
      this.element.append(header);
    }

    const grid = document.createElement("div");
    grid.className = "flmux-empty-watermark__grid";
    const kinds = options.listKinds();
    if (kinds.length === 0) {
      const empty = document.createElement("div");
      empty.className = "flmux-empty-watermark__empty";
      empty.textContent = "No pane kinds registered.";
      grid.append(empty);
    } else {
      for (const option of kinds) {
        const card = document.createElement("button");
        card.className = "flmux-empty-watermark__kind";
        fillKindButton(card, option, "flmux-empty-watermark__kind-icon");
        card.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onSelect(option.kind);
        });
        grid.append(card);
      }
    }
    this.element.append(grid);

    const footer = document.createElement("div");
    footer.className = "flmux-empty-watermark__footer";
    footer.textContent = renderAppTemplate(options.watermarkFooter, vars);
    this.element.append(footer);
  }

  init(_params: WatermarkRendererInitParameters): void {
    // noop
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}

export function humanizePaneKind(kind: string): string {
  return (
    kind
      .split(/[./_-]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || kind
  );
}

/**
 * Outer-tab renderer for workspaces. Extends `DefaultTab` to keep its
 * built-in click/drag/title behavior, then prepends a hamburger menu in
 * front of the title. The menu hosts the same pane-kind list as the
 * inner `+` and creates new panes scoped to *this* workspace — so even
 * when a workspace's inner Dockview is empty (no groups → no inner `+`),
 * the user can still add panes here.
 */
export class WorkspaceTabRenderer extends DefaultTab {
  private readonly menuButton = document.createElement("button");
  private popup: HTMLDivElement | null = null;
  private workspaceId: string | null = null;
  private initialized = false;
  private readonly documentPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (this.menuButton.contains(target) || this.popup?.contains(target))) return;
    this.closePopup();
  };
  private readonly onMenuPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly onMenuClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.togglePopup();
  };

  constructor(
    private readonly options: {
      listKinds: () => PaneKindOption[];
      onSelect: (kind: string, workspaceId: string) => void;
    }
  ) {
    super();
    this.menuButton.type = "button";
    this.menuButton.className = "workspace-tab-menu-btn";
    this.menuButton.textContent = "≡";
    this.menuButton.title = "New pane in this workspace";
    this.element.classList.add("workspace-tab");
    this.element.insertBefore(this.menuButton, this.element.firstChild);
  }

  override init(parameters: GroupPanelPartInitParameters): void {
    super.init(parameters);
    this.workspaceId = parameters.api.id;
    if (this.initialized) return;
    this.initialized = true;

    this.menuButton.addEventListener("pointerdown", this.onMenuPointerDown);
    this.menuButton.addEventListener("click", this.onMenuClick);
    document.addEventListener("pointerdown", this.documentPointerDown);

    this.addDisposables({
      dispose: () => {
        this.menuButton.removeEventListener("pointerdown", this.onMenuPointerDown);
        this.menuButton.removeEventListener("click", this.onMenuClick);
        document.removeEventListener("pointerdown", this.documentPointerDown);
        this.closePopup();
      }
    });
  }

  private togglePopup(): void {
    if (this.popup) {
      this.closePopup();
      return;
    }
    const workspaceId = this.workspaceId;
    if (!workspaceId) return;
    this.popup = openPaneKindPopup(
      this.menuButton,
      this.options.listKinds,
      (kind) => this.options.onSelect(kind, workspaceId),
      () => this.closePopup()
    );
  }

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }
}

/**
 * Inner-pane tab renderer with a hamburger menu before the title. Pane
 * runtimes (extension panes via `ctx.setHeaderMenu`, built-ins via
 * `setPaneHeaderMenu` directly) populate the registry; click reads it
 * fresh so updates between mount and click flow through. No registered
 * menu = no-op click.
 */
export interface PaneTabRendererOptions {
  /** Resolved at init/refresh. When present, replaces the default
   *  generic pane glyph with the manifest icon. */
  resolveIconUrl?(paneId: string): string | undefined;
}

export class PaneTabRenderer extends DefaultTab {
  private readonly menuButton = document.createElement("button");
  private popup: HTMLDivElement | null = null;
  private popupDispose: (() => void) | null = null;
  private paneId = "";
  private api: GroupPanelPartInitParameters["api"] | null = null;
  private initialized = false;
  private readonly documentPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (this.menuButton.contains(target) || this.popup?.contains(target))) return;
    this.closePopup();
  };
  private readonly onMenuPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly onMenuClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.togglePopup();
  };
  private readonly onTabPointerDown = (event: PointerEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.api?.close();
  };

  constructor(private readonly options: PaneTabRendererOptions = {}) {
    super();
    this.menuButton.type = "button";
    this.menuButton.className = "pane-tab-menu-btn";
    this.menuButton.title = "Pane menu";
    this.element.classList.add("pane-tab");
    this.element.insertBefore(this.menuButton, this.element.firstChild);
  }

  override init(parameters: GroupPanelPartInitParameters): void {
    super.init(parameters);
    this.paneId = parameters.api.id;
    this.api = parameters.api;
    this.applyIcon();

    // dockview can re-init the same renderer instance (panel moved between
    // groups, etc.). Bind document/menu listeners once; re-init only
    // refreshes the icon for the new pane id.
    if (this.initialized) return;
    this.initialized = true;

    this.menuButton.addEventListener("pointerdown", this.onMenuPointerDown);
    this.menuButton.addEventListener("click", this.onMenuClick);
    this.element.addEventListener("pointerdown", this.onTabPointerDown);
    document.addEventListener("pointerdown", this.documentPointerDown);

    this.addDisposables({
      dispose: () => {
        this.menuButton.removeEventListener("pointerdown", this.onMenuPointerDown);
        this.menuButton.removeEventListener("click", this.onMenuClick);
        this.element.removeEventListener("pointerdown", this.onTabPointerDown);
        document.removeEventListener("pointerdown", this.documentPointerDown);
        this.closePopup();
      }
    });
  }

  private applyIcon(): void {
    const url = this.options.resolveIconUrl?.(this.paneId) ?? "/__flmux/assets/pane.svg";
    this.menuButton.replaceChildren();
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.className = "pane-tab-menu-btn__icon";
    this.menuButton.append(img);
  }

  private togglePopup(): void {
    if (this.popup) {
      this.closePopup();
      return;
    }
    const menu = getPaneHeaderMenu(this.paneId);
    if (!menu) return; // no-op when pane has nothing registered
    this.openPopup(menu);
  }

  private openPopup(menu: PaneHeaderMenu): void {
    const popup = document.createElement("div");
    popup.className = "pane-header-menu-popup";
    document.body.append(popup);
    this.popup = popup;

    if ("items" in menu) {
      this.renderItems(popup, menu.items);
    } else {
      const dispose = menu.build(popup, { close: () => this.closePopup() });
      if (typeof dispose === "function") this.popupDispose = dispose;
    }

    positionMenuPopup(this.menuButton, popup, "start");
  }

  private renderItems(popup: HTMLDivElement, items: PaneHeaderMenuItem[]): void {
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pane-header-menu-popup__empty";
      empty.textContent = "No actions";
      popup.append(empty);
      return;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pane-header-menu-popup__item";
      button.disabled = item.disabled === true;
      if (item.icon) {
        const icon = document.createElement("span");
        icon.className = "pane-header-menu-popup__icon";
        if (/^(data:|https?:)/.test(item.icon)) {
          const img = document.createElement("img");
          img.src = item.icon;
          img.alt = "";
          icon.append(img);
        } else {
          icon.textContent = item.icon;
        }
        button.append(icon);
      }
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(label);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePopup();
        if (!item.disabled) item.onClick();
      });
      popup.append(button);
    }
  }

  private closePopup(): void {
    this.popupDispose?.();
    this.popupDispose = null;
    this.popup?.remove();
    this.popup = null;
  }
}
