import type { ClientOf } from "bunite-core/rpc";
import { BrowserWindowCap as BrowserWindowCapDef } from "bunite-core/rpc";
import { openPaneKindPopup, type PaneKindOption } from "./headerActions";
import { getThemePreference, setThemePreference, type ThemePreference } from "../theme";

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

export interface FlmuxTitlebarHandlers {
  listKinds(): PaneKindOption[];
  onAddPane(kind: string, workspaceId: string): void;
  onNewWorkspace(): void;
  onResetWorkspace(workspaceId: string): void;
  onCloseWorkspace(workspaceId: string): void;
  onActivateWorkspace(workspaceId: string): void;
}

export interface FlmuxTitlebarWorkspace {
  id: string;
  title: string;
}

type WindowCap = ClientOf<typeof BrowserWindowCapDef>;

export class FlmuxTitlebar {
  readonly element: HTMLElement;
  private readonly tabsHost = document.createElement("div");
  private readonly menusHost = document.createElement("div");
  private readonly controlsHost = document.createElement("div");
  private readonly themeBtn = document.createElement("button");
  private readonly newWsBtn = document.createElement("button");
  private readonly resetBtn = document.createElement("button");
  private readonly minBtn = document.createElement("button");
  private readonly maxBtn = document.createElement("button");
  private readonly closeBtn = document.createElement("button");
  private themePopup: HTMLDivElement | null = null;
  private addPanePopup: HTMLDivElement | null = null;
  private win: WindowCap | null = null;
  private winLoad: Promise<WindowCap> | null = null;
  private stateStream: { cancel?(): void } | null = null;
  private workspaces: FlmuxTitlebarWorkspace[] = [];
  private activeWorkspaceId: string | null = null;
  private disposed = false;

  constructor(private readonly handlers: FlmuxTitlebarHandlers) {
    this.element = document.createElement("div");
    this.element.className = "flmux-titlebar";
    this.element.dataset.buniteDragRegion = "";
    this.element.dataset.doubleclick = "maximize";

    const appLabel = document.createElement("div");
    appLabel.className = "flmux-titlebar__app";
    appLabel.textContent = "flmux";

    // Tabs container has no opt-out; individual tabs set data-bunite-no-drag.
    this.tabsHost.className = "flmux-titlebar__tabs";

    this.menusHost.className = "flmux-titlebar__menus";
    this.menusHost.dataset.buniteNoDrag = "";
    this.themeBtn.type = "button";
    this.themeBtn.className = "flmux-titlebar__btn";
    this.newWsBtn.type = "button";
    this.newWsBtn.className = "flmux-titlebar__btn";
    this.newWsBtn.textContent = "+";
    this.newWsBtn.title = "New Workspace";
    this.resetBtn.type = "button";
    this.resetBtn.className = "flmux-titlebar__btn";
    this.resetBtn.textContent = "↻";
    this.resetBtn.title = "Reset Active Workspace";
    this.syncThemeButton();
    this.menusHost.append(this.themeBtn, this.resetBtn, this.newWsBtn);

    this.controlsHost.className = "flmux-titlebar__controls";
    this.controlsHost.dataset.buniteNoDrag = "";
    this.minBtn.type = "button";
    this.minBtn.className = "flmux-titlebar__win-btn";
    this.minBtn.textContent = "–";
    this.minBtn.title = "Minimize";
    this.maxBtn.type = "button";
    this.maxBtn.className = "flmux-titlebar__win-btn";
    this.maxBtn.innerHTML = "&#x25a1;";
    this.maxBtn.title = "Maximize";
    this.closeBtn.type = "button";
    this.closeBtn.className = "flmux-titlebar__win-btn flmux-titlebar__win-btn--close";
    this.closeBtn.textContent = "✕";
    this.closeBtn.title = "Close";
    this.controlsHost.append(this.minBtn, this.maxBtn, this.closeBtn);

    this.element.append(appLabel, this.tabsHost, this.menusHost, this.controlsHost);

    this.themeBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.toggleThemePopup(); });
    this.newWsBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.handlers.onNewWorkspace(); });
    this.resetBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this.activeWorkspaceId) this.handlers.onResetWorkspace(this.activeWorkspaceId);
    });
    this.minBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void this.ensureWin().then(w => w.minimize()); });
    this.maxBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void this.ensureWin().then(w => w.toggleMaximize()); });
    this.closeBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void this.ensureWin().then(w => w.close()); });

    document.addEventListener("pointerdown", this.onDocPointerDown);
    document.addEventListener("flmux-theme-change", this.onThemeChange);

    // Eager init so initial maximize/focus glyph is correct without waiting for a click.
    void this.ensureWin().catch((err) => console.warn("[flmux titlebar] ensureWin failed", err));
  }

  private readonly onDocPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (this.themeBtn.contains(target) || this.themePopup?.contains(target))) return;
    this.closeThemePopup();
    if (target && this.addPanePopup && !this.addPanePopup.contains(target)) {
      this.closeAddPanePopup();
    }
  };

  private readonly onThemeChange = () => this.syncThemeButton();

  setWorkspaces(workspaces: FlmuxTitlebarWorkspace[], activeId: string | null) {
    this.workspaces = workspaces.slice();
    this.activeWorkspaceId = activeId;
    this.renderTabs();
  }

  private renderTabs() {
    this.tabsHost.replaceChildren();
    for (const ws of this.workspaces) {
      const tab = document.createElement("div");
      tab.className = "flmux-titlebar__tab";
      tab.dataset.buniteNoDrag = "";
      if (ws.id === this.activeWorkspaceId) tab.classList.add("flmux-titlebar__tab--active");

      const hamburger = document.createElement("button");
      hamburger.type = "button";
      hamburger.className = "flmux-titlebar__tab-menu";
      hamburger.textContent = "≡";
      hamburger.title = "New pane in this workspace";
      hamburger.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.openAddPanePopup(hamburger, ws.id);
      });

      const title = document.createElement("div");
      title.className = "flmux-titlebar__tab-title";
      title.textContent = ws.title;
      title.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.handlers.onActivateWorkspace(ws.id);
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "flmux-titlebar__tab-close";
      close.textContent = "✕";
      close.title = "Close workspace";
      close.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.handlers.onCloseWorkspace(ws.id);
      });

      tab.append(hamburger, title, close);
      this.tabsHost.append(tab);
    }
  }

  private openAddPanePopup(anchor: HTMLElement, workspaceId: string) {
    this.closeAddPanePopup();
    this.addPanePopup = openPaneKindPopup(
      anchor,
      () => this.handlers.listKinds(),
      (kind) => this.handlers.onAddPane(kind, workspaceId),
      () => this.closeAddPanePopup()
    );
  }

  private closeAddPanePopup() {
    this.addPanePopup?.remove();
    this.addPanePopup = null;
  }

  private async ensureWin(): Promise<WindowCap> {
    if (this.win) return this.win;
    if (this.winLoad) return this.winLoad;
    const load = (async () => {
      const host = (window as unknown as { host?: { runtime(): Promise<unknown> } }).host;
      if (!host?.runtime) throw new Error("bunite preload host missing — frameless titlebar requires desktop preload");
      const runtime = await host.runtime() as { window(): Promise<{ current(): Promise<WindowCap> }> };
      const winCap = await runtime.window();
      this.win = await winCap.current();
      this.startStateWatch();
      return this.win!;
    })();
    this.winLoad = load;
    load.catch(() => { if (this.winLoad === load) this.winLoad = null; });
    return load;
  }

  private startStateWatch() {
    if (!this.win || this.disposed) return;
    const stream = this.win.stateWatch() as AsyncIterable<{ maximized: boolean; minimized: boolean; focused: boolean }> & { cancel?(): void };
    this.stateStream = stream;
    void (async () => {
      try {
        for await (const s of stream) {
          if (this.disposed) break;
          this.applyState(s);
        }
      } catch (err) {
        if (!this.disposed) console.warn("[flmux titlebar] stateWatch ended", err);
      }
    })();
  }

  private applyState(s: { maximized: boolean; minimized: boolean; focused: boolean }) {
    this.maxBtn.innerHTML = s.maximized ? "&#x2750;" : "&#x25a1;";
    this.maxBtn.title = s.maximized ? "Restore" : "Maximize";
    this.element.classList.toggle("flmux-titlebar--blurred", !s.focused);
  }

  private toggleThemePopup() {
    if (this.themePopup) this.closeThemePopup();
    else this.openThemePopup();
  }

  private openThemePopup() {
    const current = getThemePreference();
    const popup = document.createElement("div");
    popup.className = "header-action-popup";
    for (const option of THEME_OPTIONS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "header-action-popup__item";
      if (option.preference === current) item.classList.add("header-action-popup__item--active");
      item.textContent = `${THEME_GLYPH[option.preference]}  ${option.label}`;
      item.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.closeThemePopup();
        setThemePreference(option.preference);
        this.syncThemeButton();
      });
      popup.append(item);
    }
    document.body.append(popup);
    this.themePopup = popup;
    const rect = this.themeBtn.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(4, rect.right - popup.offsetWidth)}px`;
  }

  private closeThemePopup() {
    this.themePopup?.remove();
    this.themePopup = null;
  }

  private syncThemeButton() {
    const preference = getThemePreference();
    this.themeBtn.textContent = THEME_GLYPH[preference];
    this.themeBtn.title = `Theme: ${preference[0]!.toUpperCase()}${preference.slice(1)}`;
  }

  dispose() {
    this.disposed = true;
    this.stateStream?.cancel?.();
    this.stateStream = null;
    document.removeEventListener("pointerdown", this.onDocPointerDown);
    document.removeEventListener("flmux-theme-change", this.onThemeChange);
    this.closeThemePopup();
    this.closeAddPanePopup();
    this.element.remove();
  }
}

