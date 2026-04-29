import type {
  GroupPanelPartInitParameters,
  IHeaderActionsRenderer,
  IGroupHeaderProps,
  DockviewGroupPanel
} from "dockview-core";
import { DefaultTab } from "dockview-core";
import type { PaneHeaderMenu, PaneHeaderMenuItem } from "@flmux/extension-api";
import { getPaneHeaderMenu } from "../external/paneTabMenuRegistry";
import { getThemePreference, setThemePreference, type ThemePreference } from "../theme";

/** Inline hamburger SVG — three short bars, currentColor for theming. */
const HAMBURGER_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

type Disposer = () => void;

const THEME_GLYPH: Record<ThemePreference, string> = {
  light: "☀",
  dark: "☾",
  system: "◐"
};

const THEME_OPTIONS: ReadonlyArray<{ preference: ThemePreference; label: string }> = [
  { preference: "light", label: "Light" },
  { preference: "dark", label: "Dark" },
  { preference: "system", label: "System" }
];

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
  private readonly themeButton = document.createElement("button");
  private readonly resetButton = document.createElement("button");
  private readonly addButton = document.createElement("button");
  private themePopup: HTMLDivElement | null = null;
  private disposers: Array<() => void> = [];

  constructor(
    _group: DockviewGroupPanel,
    private readonly handlers: { onAdd: () => void; onResetActive: () => void }
  ) {
    this.element.className = "header-action";
    this.themeButton.type = "button";
    this.themeButton.className = "header-action__btn";
    this.syncThemeButton();
    this.resetButton.type = "button";
    this.resetButton.className = "header-action__btn";
    this.resetButton.textContent = "↻";
    this.resetButton.title = "Reset Active Workspace";
    this.addButton.type = "button";
    this.addButton.className = "header-action__btn";
    this.addButton.textContent = "+";
    this.addButton.title = "New Workspace";
    this.element.append(this.themeButton, this.resetButton, this.addButton);
  }

  init(_params: IGroupHeaderProps) {
    const addListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onAdd();
    };
    const resetListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onResetActive();
    };
    const themeListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleThemePopup();
    };
    const docPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.themeButton.contains(target) || this.themePopup?.contains(target))) return;
      this.closeThemePopup();
    };
    const themeChangeListener = () => this.syncThemeButton();

    this.addButton.addEventListener("click", addListener);
    this.resetButton.addEventListener("click", resetListener);
    this.themeButton.addEventListener("click", themeListener);
    document.addEventListener("pointerdown", docPointerDown);
    document.addEventListener("flmux-theme-change", themeChangeListener);
    this.disposers.push(
      () => this.addButton.removeEventListener("click", addListener),
      () => this.resetButton.removeEventListener("click", resetListener),
      () => this.themeButton.removeEventListener("click", themeListener),
      () => document.removeEventListener("pointerdown", docPointerDown),
      () => document.removeEventListener("flmux-theme-change", themeChangeListener)
    );
  }

  private syncThemeButton() {
    const preference = getThemePreference();
    this.themeButton.textContent = THEME_GLYPH[preference];
    this.themeButton.title = `Theme: ${preference[0]!.toUpperCase()}${preference.slice(1)}`;
  }

  private toggleThemePopup() {
    if (this.themePopup) {
      this.closeThemePopup();
    } else {
      this.openThemePopup();
    }
  }

  private openThemePopup() {
    const current = getThemePreference();
    const popup = document.createElement("div");
    popup.className = "header-action-popup";

    for (const option of THEME_OPTIONS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "header-action-popup__item";
      if (option.preference === current) {
        item.classList.add("header-action-popup__item--active");
      }
      item.textContent = `${THEME_GLYPH[option.preference]}  ${option.label}`;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeThemePopup();
        setThemePreference(option.preference);
        this.syncThemeButton();
      });
      popup.append(item);
    }

    document.body.append(popup);
    this.themePopup = popup;

    const rect = this.themeButton.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(4, rect.right - popup.offsetWidth)}px`;
  }

  private closeThemePopup() {
    this.themePopup?.remove();
    this.themePopup = null;
  }

  dispose() {
    this.closeThemePopup();
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.element.replaceChildren();
  }
}

export interface PaneKindOption {
  kind: string;
  label: string;
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
      item.type = "button";
      item.className = "header-action-popup__item";
      item.textContent = `New ${option.label}`;
      item.dataset.kind = option.kind;
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

  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 4}px`;
  popup.style.left = `${Math.max(4, rect.right - popup.offsetWidth)}px`;

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
      this.popup = openPaneKindPopup(
        this.button,
        this.options.listKinds,
        this.options.onSelect,
        () => this.closePopup()
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
  /** Resolved at init/refresh — when present, replaces the default
   *  hamburger SVG with `<img src=...>`. */
  resolveIconUrl?(paneId: string): string | undefined;
}

export class PaneTabRenderer extends DefaultTab {
  private readonly menuButton = document.createElement("button");
  private popup: HTMLDivElement | null = null;
  private popupDispose: (() => void) | null = null;
  private paneId = "";
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

  constructor(private readonly options: PaneTabRendererOptions = {}) {
    super();
    this.menuButton.type = "button";
    this.menuButton.className = "pane-tab-menu-btn";
    this.menuButton.title = "Pane menu";
    this.menuButton.innerHTML = HAMBURGER_SVG;
    this.element.classList.add("pane-tab");
    this.element.insertBefore(this.menuButton, this.element.firstChild);
  }

  override init(parameters: GroupPanelPartInitParameters): void {
    super.init(parameters);
    this.paneId = parameters.api.id;
    this.applyIcon();

    // dockview can re-init the same renderer instance (panel moved between
    // groups, etc.). Bind document/menu listeners once; re-init only
    // refreshes the icon for the new pane id.
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

  private applyIcon(): void {
    const url = this.options.resolveIconUrl?.(this.paneId);
    if (!url) {
      this.menuButton.innerHTML = HAMBURGER_SVG;
      return;
    }
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

    const rect = this.menuButton.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(4, rect.left)}px`;
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
