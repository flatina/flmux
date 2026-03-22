import "@xterm/xterm/css/xterm.css";
import "dockview-core/dist/styles/dockview.css";
import "./styles.css";

import { type AddPanelOptions, createDockview, type DockviewApi } from "dockview-core";
import type {
  AppSummary,
  PaneCloseParams,
  PaneCreateInput,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitParams,
  PaneSummary,
  TabCloseParams,
  TabFocusParams,
  TabListResult,
  TabOpenParams,
  TabResult,
  TabSummary
} from "../shared/app-rpc";
import type { BootstrapState } from "../shared/bootstrap-state";
import { createFlmuxLastFile } from "../shared/flmux-last";
import {
  asPaneId,
  asTabId,
  createPaneId,
  createTabId,
  createTerminalRuntimeId,
  type PaneId,
  type TerminalRuntimeId
} from "../shared/ids";
import {
  createPaneParams,
  getDefaultPaneTitle,
  isPaneParams,
  type PaneParams
} from "../shared/pane-params";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../shared/rpc";
import { info } from "../shared/logger";
import type { LayoutableTabParams } from "../shared/tab-params";
import { AppOwner, EventBus } from "./event-bus";
import {
  isV1Layout,
  migrateV1Layout,
  panelToSummary,
  sanitizeSerializedLayout,
  titleFromLeaf
} from "./helpers";
import { getHostRpc, setRendererRpcHandlers } from "./lib/host-rpc";
import type { PaneRendererContext } from "./pane-renderer";
import { TabRenderer } from "./tab-renderer";

void bootstrapRenderer();

async function bootstrapRenderer(): Promise<void> {
  const bootstrap = await getHostRpc().request("bootstrap.get", undefined);
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) {
    throw new Error("Renderer root #app not found");
  }

  const app = new WorkspaceApp(root, bootstrap);
  await app.init();
  setRendererRpcHandlers({
    "workspace.summary": () => app.getSummary(),
    "workspace.open": (params) => app.openPaneFromRpc(params),
    "workspace.focus": (params) => app.focusPaneFromRpc(params),
    "workspace.close": (params) => app.closePaneFromRpc(params),
    "workspace.split": (params) => app.splitPaneFromRpc(params),
    "workspace.tab.open": (params) => app.tabOpenFromRpc(params),
    "workspace.tab.list": () => app.tabListFromRpc(),
    "workspace.tab.focus": (params) => app.tabFocusFromRpc(params),
    "workspace.tab.close": (params) => app.tabCloseFromRpc(params),
    "workspace.pane.message": (params) => app.paneMessageFromRpc(params)
  });
}

class WorkspaceApp {
  private readonly hostRpc = getHostRpc();
  private readonly eventBus = new EventBus();
  private readonly terminalRuntimes = new Map<TerminalRuntimeId, TerminalRuntimeSummary>();
  private readonly preCloseHooks = new Map<PaneId, () => void>();
  private readonly tabRenderers = new Map<string, TabRenderer>();

  private readonly shell = document.createElement("div");
  private readonly titlebar = document.createElement("header");
  private readonly titlebarTitle = document.createElement("span");
  private readonly workspaceHost = document.createElement("section");

  private dockview: DockviewApi | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private saveTimer = 0;
  private terminalEventUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly bootstrap: BootstrapState
  ) {
    for (const runtime of this.bootstrap.liveTerminalRuntimes) {
      this.terminalRuntimes.set(runtime.runtimeId, runtime);
    }
  }

  async init(): Promise<void> {
    this.shell.className = "app-shell";
    this.titlebar.className = "titlebar electrobun-webkit-app-region-drag";
    this.workspaceHost.className = "workspace-host dockview-theme-flmux";

    this.buildTitlebar();

    this.shell.append(this.titlebar, this.workspaceHost);
    this.root.replaceChildren(this.shell);

    const paneContext: PaneRendererContext = {
      workspaceRoot: this.bootstrap.cwd,
      getTerminalRuntime: (runtimeId) => this.terminalRuntimes.get(runtimeId) ?? null,
      getExtensionRegistry: () => this.bootstrap.extensions,
      getTabId: () => asTabId(""),
      emitEvent: (source, tabId, eventType, data) => this.eventBus.emit(source, tabId, eventType, data),
      onEvent: (ownerPaneId, ownerTabId, eventType, handler, options) =>
        this.eventBus.on(ownerPaneId, ownerTabId, eventType, handler, options),
      disposePaneEvents: (paneId) => this.eventBus.disposePane(paneId),
      markDirty: () => this.queueSave(),
      openEditorForFile: (filePath, sourcePaneId) => this.openEditorForFile(filePath, sourcePaneId),
      registerPreCloseHook: (paneId, hook) => this.preCloseHooks.set(paneId, hook),
      unregisterPreCloseHook: (paneId) => this.preCloseHooks.delete(paneId),
      firePreCloseHook: (paneId) => {
        this.preCloseHooks.get(paneId)?.();
        this.preCloseHooks.delete(paneId);
      }
    };

    this.dockview = createDockview(this.workspaceHost, {
      className: "dockview-theme-flmux",
      defaultRenderer: "always",
      createComponent: () =>
        new TabRenderer({
          paneContext,
          markDirty: () => this.queueSave(),
          register: (panelId, renderer) => this.tabRenderers.set(panelId, renderer),
          unregister: (panelId) => this.tabRenderers.delete(panelId),
          onGroupAction: (action, panelId) => this.handleInnerGroupAction(action, panelId),
          getTabIndex: (panelId) => this.dockview?.panels.findIndex((p) => p.id === panelId) ?? 0
        })
    });

    this.dockview.onDidLayoutChange(() => {
      this.queueSave();
      this.updateOuterTabVisibility();
    });
    this.dockview.onDidAddPanel(() => this.updateOuterTabVisibility());
    this.dockview.onDidRemovePanel(() => this.updateOuterTabVisibility());
    this.dockview.onDidRemovePanel((panel) => {
      const paneId = asPaneId(panel.id);
      this.preCloseHooks.get(paneId)?.();
      this.preCloseHooks.delete(paneId);
    });
    this.attachResizeObserver();
    this.terminalEventUnsubscribe =
      this.hostRpc.subscribe?.("terminal.event", (event) => this.handleTerminalEvent(event)) ?? null;
    window.addEventListener("flmux:layout-dirty", this.handleDirty);
    window.addEventListener("beforeunload", this.handleBeforeUnload);

    // Listen for app:title events from extensions
    this.eventBus.on(AppOwner.paneId, AppOwner.tabId, "app:title", (event) => {
      const title = (event.data as { title?: string })?.title;
      if (typeof title === "string") this.titlebarTitle.textContent = title;
    }, { global: true });

    await this.restoreOrSeedLayout();
  }

  private buildTitlebar(): void {
    // Left: app title (drag region)
    const left = document.createElement("div");
    left.className = "titlebar-left";
    this.titlebarTitle.className = "titlebar-title";
    this.titlebarTitle.textContent = "flmux";
    left.append(this.titlebarTitle);

    // Center: action buttons (no-drag)
    const center = document.createElement("div");
    center.className = "titlebar-center electrobun-webkit-app-region-no-drag";
    center.append(
      this.makeTitlebarBtn(">_", "New Terminal Tab", () => void this.openNewTerminalTab()),
      this.makeTitlebarBtn("\u{1F310}", "New Browser Tab", () => void this.openNewBrowserTab()),
      this.buildSessionMenu()
    );

    // Right: window controls (no-drag)
    const right = document.createElement("div");
    right.className = "titlebar-window-controls electrobun-webkit-app-region-no-drag";
    right.append(
      this.makeWindowBtn("\u2500", "Minimize", () => void this.hostRpc.request("window.minimize", undefined)),
      this.makeWindowBtn("\u25A1", "Maximize", () => void this.hostRpc.request("window.maximize", undefined)),
      this.makeWindowBtn("\u2715", "Close", () => void this.hostRpc.request("window.close", undefined), "window-btn-close")
    );

    this.titlebar.replaceChildren(left, center, right);
  }

  private makeTitlebarBtn(icon: string, tooltip: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "titlebar-btn";
    btn.textContent = icon;
    btn.title = tooltip;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private makeWindowBtn(icon: string, tooltip: string, onClick: () => void, extra?: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `window-btn${extra ? ` ${extra}` : ""}`;
    btn.textContent = icon;
    btn.title = tooltip;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private buildSessionMenu(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "titlebar-menu-wrapper";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "titlebar-btn";
    trigger.textContent = "\u{1F4D1}";
    trigger.title = "Session";

    const menu = document.createElement("div");
    menu.className = "titlebar-menu";
    menu.hidden = true;

    const makeItem = (text: string, onClick: () => void) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "titlebar-menu-item";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        menu.hidden = true;
        onClick();
      });
      return btn;
    };

    menu.append(
      makeItem("Save Session\u2026", () => void this.saveSessionAs()),
      makeItem("Load Session\u2026", () => void this.showLoadSessionMenu(menu)),
      makeItem("Load Last Session", () => void this.loadLastSession()),
    );

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    document.addEventListener("click", (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) menu.hidden = true;
    });

    wrapper.append(trigger, menu);
    return wrapper;
  }

  /** Create a new layoutable tab with a fresh terminal inside. */
  private async openNewTerminalTab(): Promise<void> {
    if (!this.dockview) return;
    const layoutTabId = createTabId("layout");
    this.dockview.addPanel({
      id: layoutTabId,
      component: "flmux-tab",
      title: "Workspace",
      params: {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null
      } as LayoutableTabParams
    });
    const renderer = this.tabRenderers.get(layoutTabId);
    if (renderer) {
      const paneId = createPaneId("terminal");
      const params = await this.createParamsForLeaf({ kind: "terminal" });
      renderer.addPane(paneId, "Terminal", params);
    }
    this.dockview.getPanel(layoutTabId)?.focus();
    this.queueSave();
  }

  /** Create a new layoutable tab with a browser inside. */
  private async openNewBrowserTab(): Promise<void> {
    if (!this.dockview) return;
    const layoutTabId = createTabId("layout");
    this.dockview.addPanel({
      id: layoutTabId,
      component: "flmux-tab",
      title: "Browser",
      params: {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null
      } as LayoutableTabParams
    });
    const renderer = this.tabRenderers.get(layoutTabId);
    if (renderer) {
      const paneId = createPaneId("browser");
      const params = await this.createParamsForLeaf({ kind: "browser" });
      renderer.addPane(paneId, "Browser", params);
    }
    this.dockview.getPanel(layoutTabId)?.focus();
    this.queueSave();
  }

  private async saveSessionAs(): Promise<void> {
    const name = prompt("Session name:", `session-${new Date().toISOString().slice(0, 10)}`);
    if (!name?.trim()) return;

    if (!this.dockview) return;

    for (const renderer of this.tabRenderers.values()) {
      renderer.flushInnerLayout();
    }

    const windowFrame = await this.hostRpc.request("window.frame.get", undefined);
    const file = createFlmuxLastFile({
      activePaneId: this.getActivePaneId(),
      workspaceLayout: sanitizeSerializedLayout(this.dockview.toJSON()).layout,
      window: windowFrame
    });
    file.name = name.trim();

    await this.hostRpc.request("session.save", { name: name.trim(), file });
    // Also save as last session
    await this.hostRpc.request("flmuxLast.save", { file });
  }

  private async showLoadSessionMenu(parentMenu: HTMLElement): Promise<void> {
    const { sessions } = await this.hostRpc.request("session.list", undefined);
    if (sessions.length === 0) {
      alert("No saved sessions found.");
      return;
    }

    // Remove previous session list items
    parentMenu.querySelectorAll(".session-list-item").forEach((el) => el.remove());

    const sep = document.createElement("hr");
    sep.className = "session-list-item";
    sep.style.cssText = "border:none;border-top:1px solid #444;margin:4px 0;";
    parentMenu.append(sep);

    for (const s of sessions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "titlebar-menu-item session-list-item";
      btn.textContent = s.name;
      btn.title = s.savedAt ? `Saved: ${s.savedAt}` : "";
      btn.addEventListener("click", () => {
        parentMenu.hidden = true;
        parentMenu.querySelectorAll(".session-list-item").forEach((el) => el.remove());
        void this.loadNamedSession(s.name);
      });
      parentMenu.append(btn);
    }

    parentMenu.hidden = false;
  }

  private async loadNamedSession(name: string): Promise<void> {
    if (!this.dockview) return;

    const { file } = await this.hostRpc.request("session.load", { name });
    if (!file?.workspaceLayout) return;

    try {
      const source = isV1Layout(file.workspaceLayout) ? migrateV1Layout(file.workspaceLayout) : file.workspaceLayout;
      const { layout } = sanitizeSerializedLayout(source);
      this.dockview.fromJSON(layout);
      if (file.activePaneId) {
        this.dockview.getPanel(file.activePaneId)?.focus();
      }
      this.queueSave();
    } catch {
      // ignore
    }
  }

  private async loadLastSession(): Promise<void> {
    if (!this.dockview) return;

    const { file } = await this.hostRpc.request("flmuxLast.load", undefined);
    if (!file?.workspaceLayout) return;

    try {
      const source = isV1Layout(file.workspaceLayout) ? migrateV1Layout(file.workspaceLayout) : file.workspaceLayout;
      const { layout } = sanitizeSerializedLayout(source);
      this.dockview.fromJSON(layout);
      if (file.activePaneId) {
        this.dockview.getPanel(file.activePaneId)?.focus();
      }
      this.queueSave();
    } catch {
      // ignore invalid layout
    }
  }

  private async restoreOrSeedLayout(): Promise<void> {
    if (!this.dockview) {
      return;
    }

    const { file } = await this.hostRpc.request("flmuxLast.load", undefined);

    if (this.bootstrap.restoreLayout && file?.workspaceLayout) {
      try {
        const source = isV1Layout(file.workspaceLayout) ? migrateV1Layout(file.workspaceLayout) : file.workspaceLayout;
        const { changed, layout } = sanitizeSerializedLayout(source);
        this.dockview.fromJSON(layout);
        if (file.activePaneId) {
          this.dockview.getPanel(file.activePaneId)?.focus();
        }
        if (this.dockview.panels.length > 0) {
          if (changed) {
            this.queueSave();
          }
          return;
        }
      } catch {
        // fall through to starter panels
      }
    }

    // Fresh start: single layoutable tab with one terminal
    const layoutTabId = createTabId("layout");
    this.dockview.addPanel({
      id: layoutTabId,
      component: "flmux-tab",
      title: "Workspace",
      params: {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null
      } as LayoutableTabParams
    });
    const layoutRenderer = this.tabRenderers.get(layoutTabId);
    if (layoutRenderer) {
      const terminalPaneId = createPaneId("terminal");
      const terminalParams = await this.createParamsForLeaf({ kind: "terminal" });
      layoutRenderer.addPane(terminalPaneId, "Terminal", terminalParams);
    }
  }

  async openEditorForFile(filePath: string, sourcePaneId?: string): Promise<void> {
    await this.openLeaf(
      { kind: "editor", filePath },
      sourcePaneId ? { referencePaneId: asPaneId(sourcePaneId), direction: "right" } : {}
    );
  }

  async openPaneFromRpc(params: PaneOpenParams): Promise<PaneResult> {
    return this.openLeaf(params.leaf, {
      referencePaneId: params.referencePaneId,
      direction: params.direction
    });
  }

  focusPaneFromRpc(params: PaneFocusParams): PaneResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const found = this.findPane(params.paneId);
    if (!found) {
      throw new Error(`pane.focus target pane not found: ${params.paneId}`);
    }

    found.outerPanel.focus();
    found.innerPanel?.focus();
    return this.makePaneResult(params.paneId);
  }

  async closePaneFromRpc(params: PaneCloseParams): Promise<PaneResult> {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const found = this.findPane(params.paneId);
    if (!found) {
      throw new Error(`pane.close target pane not found: ${params.paneId}`);
    }
    info("pane", `close id=${params.paneId}`);

    this.preCloseHooks.get(params.paneId)?.();
    this.preCloseHooks.delete(params.paneId);

    const panel = found.innerPanel ?? found.outerPanel;
    const paneParams = panel.params;
    if (isPaneParams(paneParams) && paneParams.kind === "terminal") {
      await this.hostRpc.request("terminal.kill", {
        runtimeId: paneParams.runtimeId
      });
      this.terminalRuntimes.delete(paneParams.runtimeId);
    }

    panel.api.close();
    this.queueSave();
    return this.makePaneResult(params.paneId);
  }

  paneMessageFromRpc(params: PaneMessageParams): PaneMessageResult {
    const found = this.findPane(params.paneId);
    if (!found) {
      return { ok: true, delivered: false };
    }

    const tabId = asTabId(found.outerPanel.id);
    this.eventBus.emit(params.paneId, tabId, params.eventType, params.data);
    return { ok: true, delivered: true };
  }

  async splitPaneFromRpc(params: PaneSplitParams): Promise<PaneResult> {
    return this.openLeaf(params.leaf, {
      referencePaneId: params.paneId,
      direction: params.direction
    });
  }

  getSummary(): AppSummary {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const panes: PaneSummary[] = [];
    for (const panel of this.dockview.panels) {
      const tabId = asTabId(panel.id);
      const renderer = this.tabRenderers.get(panel.id);
      if (renderer?.isLayoutable && renderer.innerApi) {
        for (const innerPanel of renderer.innerApi.panels) {
          const innerParams = innerPanel.params as PaneParams;
          if (isPaneParams(innerParams)) {
            panes.push(
              panelToSummary(
                innerPanel.id,
                tabId,
                innerPanel.title ?? getDefaultPaneTitle(innerParams.kind),
                innerParams
              )
            );
          }
        }
      } else {
        const params = panel.params as PaneParams;
        if (isPaneParams(params)) {
          panes.push(panelToSummary(panel.id, tabId, panel.title ?? getDefaultPaneTitle(params.kind), params));
        }
      }
    }

    return {
      activePaneId: this.getActivePaneId(),
      panes,
      webServerUrl: this.bootstrap.webServerUrl,
      browserAutomation: {
        cdpBaseUrl: this.bootstrap.browserAutomation.cdpBaseUrl
      }
    };
  }

  tabListFromRpc(): TabListResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const tabs: TabSummary[] = [];
    for (const panel of this.dockview.panels) {
      const renderer = this.tabRenderers.get(panel.id);
      const layoutMode = renderer?.isLayoutable ? "layoutable" : "simple";
      const paneCount = renderer?.isLayoutable && renderer.innerApi ? renderer.innerApi.panels.length : 1;
      tabs.push({
        tabId: asTabId(panel.id),
        layoutMode,
        title: panel.title ?? "Tab",
        paneCount
      });
    }

    return { tabs };
  }

  tabOpenFromRpc(params: TabOpenParams): TabResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const tabId = createTabId(params.layoutMode === "layoutable" ? "layout" : "tab");
    const title = params.title ?? (params.layoutMode === "layoutable" ? "Workspace" : "Tab");

    if (params.layoutMode === "layoutable") {
      this.dockview.addPanel({
        id: tabId,
        component: "flmux-tab",
        title,
        params: { tabKind: "tab", layoutMode: "layoutable", innerLayout: null, activePaneId: null }
      });
    } else {
      throw new Error("tab.open for simple/stack tabs requires a pane — use pane.open instead");
    }

    this.dockview.getPanel(tabId)?.focus();
    this.queueSave();
    return { ok: true, tabId };
  }

  tabFocusFromRpc(params: TabFocusParams): TabResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const panel = this.dockview.getPanel(params.tabId);
    if (!panel) {
      throw new Error(`tab.focus target tab not found: ${params.tabId}`);
    }

    panel.focus();
    return { ok: true, tabId: params.tabId };
  }

  tabCloseFromRpc(params: TabCloseParams): TabResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const panel = this.dockview.getPanel(params.tabId);
    if (!panel) {
      throw new Error(`tab.close target tab not found: ${params.tabId}`);
    }

    // Fire preCloseHooks for panes inside this tab
    const renderer = this.tabRenderers.get(params.tabId);
    if (renderer?.isLayoutable && renderer.innerApi) {
      for (const innerPanel of renderer.innerApi.panels) {
        const paneId = asPaneId(innerPanel.id);
        this.preCloseHooks.get(paneId)?.();
        this.preCloseHooks.delete(paneId);
      }
    } else {
      const paneId = asPaneId(params.tabId);
      this.preCloseHooks.get(paneId)?.();
      this.preCloseHooks.delete(paneId);
    }

    panel.api.close();
    this.queueSave();
    return { ok: true, tabId: params.tabId };
  }

  private async openLeaf(
    leaf: PaneCreateInput,
    options: {
      referencePaneId?: PaneId;
      direction?: "within" | "left" | "right" | "above" | "below";
    } = {}
  ): Promise<PaneResult> {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const paneId = createPaneId(leaf.kind);
    const title = titleFromLeaf(leaf);
    const params = await this.createParamsForLeaf(leaf);
    info("pane", `open ${leaf.kind} id=${paneId}${options.direction ? ` dir=${options.direction}` : ""}`);

    return this.openInLayoutableTab(paneId, title, params, options);
  }

  private openInLayoutableTab(
    paneId: PaneId,
    title: string,
    params: PaneParams,
    options: {
      referencePaneId?: PaneId;
      direction?: "within" | "left" | "right" | "above" | "below";
    }
  ): PaneResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    // If reference pane is in a layoutable tab, split there
    if (options.referencePaneId) {
      const found = this.findPane(options.referencePaneId);
      if (found?.innerApi) {
        found.innerApi.addPanel({
          id: paneId,
          component: "flmux-pane",
          title,
          params,
          position: {
            referencePanel: options.referencePaneId,
            direction: options.direction ?? "within"
          }
        } as AddPanelOptions<PaneParams>);
        found.outerPanel.focus();
        this.queueSave();
        return this.makePaneResult(paneId);
      }
    }

    // Find first layoutable tab or create one
    let layoutTabId: string | null = null;
    let renderer: TabRenderer | null = null;

    for (const [tabId, r] of this.tabRenderers) {
      if (r.isLayoutable) {
        layoutTabId = tabId;
        renderer = r;
        break;
      }
    }

    if (!renderer || !layoutTabId) {
      layoutTabId = createTabId("layout");
      this.dockview.addPanel({
        id: layoutTabId,
        component: "flmux-tab",
        title: "Workspace",
        params: {
          tabKind: "tab",
          layoutMode: "layoutable",
          innerLayout: null,
          activePaneId: null
        } as LayoutableTabParams
      });
      renderer = this.tabRenderers.get(layoutTabId) ?? null;
    }

    if (!renderer) {
      throw new Error("Failed to create layoutable tab");
    }

    renderer.addPane(paneId, title, params);
    this.dockview.getPanel(layoutTabId)?.focus();
    this.queueSave();
    return this.makePaneResult(paneId);
  }

  private async createParamsForLeaf(leaf: PaneCreateInput): Promise<PaneParams> {
    if (leaf.kind === "terminal") {
      const runtimeId = createTerminalRuntimeId();
      return createPaneParams("terminal", {
        runtimeId,
        cwd: leaf.cwd ?? this.bootstrap.cwd,
        shell: leaf.shell ?? null,
        renderer: leaf.renderer ?? this.bootstrap.terminalRendererDefault
      });
    }

    if (leaf.kind === "browser") {
      return createPaneParams("browser", {
        url: leaf.url ?? "about:blank",
        adapter: leaf.adapter ?? this.bootstrap.browserPaneDefaultAdapter
      });
    }

    if (leaf.kind === "editor") {
      return createPaneParams("editor", {
        filePath: leaf.filePath ?? null,
        language: leaf.language ?? null
      });
    }

    if (leaf.kind === "explorer") {
      return createPaneParams("explorer", {
        rootPath: leaf.rootPath ?? this.bootstrap.cwd,
        mode: leaf.mode ?? "filetree",
        watchEnabled: leaf.watchEnabled ?? true
      });
    }

    return createPaneParams("extension", {
      extensionId: leaf.extensionId,
      contributionId: leaf.contributionId
    });
  }

  private handleInnerGroupAction(action: string, activePanelId: string | null): void {
    const ref = activePanelId ? asPaneId(activePanelId) : undefined;
    switch (action) {
      case "terminal":
        void this.openLeaf({ kind: "terminal" }, ref ? { referencePaneId: ref, direction: "within" } : {});
        break;
      case "browser":
        void this.openLeaf({ kind: "browser" }, ref ? { referencePaneId: ref, direction: "right" } : {});
        break;
      case "explorer":
        void this.openLeaf({ kind: "explorer" }, ref ? { referencePaneId: ref, direction: "left" } : {});
        break;
      case "split-right":
        void this.splitFromPane(ref, "right");
        break;
      case "split-down":
        void this.splitFromPane(ref, "below");
        break;
    }
  }

  private async splitFromPane(
    referencePaneId: PaneId | undefined,
    direction: "left" | "right" | "above" | "below"
  ): Promise<void> {
    const ref = referencePaneId ?? this.findActiveInnerPaneId();
    if (!ref) {
      await this.openLeaf({ kind: "terminal" });
      return;
    }
    const cwd = this.getTerminalCwd(this.findPane(ref)?.innerPanel?.params ?? undefined);
    await this.openLeaf({ kind: "terminal", cwd }, { referencePaneId: ref, direction });
  }

  private findActiveInnerPaneId(): PaneId | undefined {
    for (const renderer of this.tabRenderers.values()) {
      if (renderer.isLayoutable && renderer.innerApi?.activePanel) {
        return asPaneId(renderer.innerApi.activePanel.id);
      }
    }
    return undefined;
  }


  /** Extract the live cwd from a terminal pane's runtime, falling back to params cwd. */
  private getTerminalCwd(params: Record<string, unknown> | undefined): string | undefined {
    if (!params) {
      return undefined;
    }
    if (!isPaneParams(params) || params.kind !== "terminal") {
      return undefined;
    }
    const runtime = this.terminalRuntimes.get(params.runtimeId);
    return runtime?.cwd ?? params.cwd ?? undefined;
  }

  private queueSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.saveNow();
    }, 200);
  }

  private async saveNow(): Promise<void> {
    if (!this.dockview) {
      return;
    }

    // Flush inner layouts before serializing
    for (const renderer of this.tabRenderers.values()) {
      renderer.flushInnerLayout();
    }

    const windowFrame = await this.hostRpc.request("window.frame.get", undefined);
    const file = createFlmuxLastFile({
      activePaneId: this.getActivePaneId(),
      workspaceLayout: sanitizeSerializedLayout(this.dockview.toJSON()).layout,
      window: windowFrame
    });

    await this.hostRpc.request("flmuxLast.save", { file });
  }

  private readonly handleDirty = (): void => {
    this.queueSave();
  };

  private readonly handleBeforeUnload = (): void => {
    window.removeEventListener("flmux:layout-dirty", this.handleDirty);
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    window.clearTimeout(this.saveTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminalEventUnsubscribe?.();
    this.terminalEventUnsubscribe = null;
    this.preCloseHooks.clear();
  };

  private makePaneResult(paneId: PaneId): PaneResult {
    return {
      ok: true,
      paneId,
      activePaneId: this.getActivePaneId()
    };
  }

  private getActivePaneId(): PaneId | null {
    if (!this.dockview?.activePanel) {
      return null;
    }

    const renderer = this.tabRenderers.get(this.dockview.activePanel.id);
    if (renderer?.isLayoutable && renderer.innerApi?.activePanel) {
      return asPaneId(renderer.innerApi.activePanel.id);
    }

    return asPaneId(this.dockview.activePanel.id);
  }

  private findPane(paneId: PaneId): {
    outerPanel: { id: string; focus: () => void; api: { close: () => void }; params: Record<string, unknown> };
    innerApi: DockviewApi | null;
    innerPanel: {
      id: string;
      focus: () => void;
      api: { close: () => void };
      params: Record<string, unknown>;
      title?: string;
    } | null;
  } | null {
    if (!this.dockview) {
      return null;
    }

    // Check outer Dockview (simple tabs where panel.id = pane.id)
    const outerPanel = this.dockview.getPanel(paneId);
    if (outerPanel) {
      return { outerPanel: outerPanel as any, innerApi: null, innerPanel: null };
    }

    // Check inner Dockviews (layoutable tabs)
    for (const [tabId, renderer] of this.tabRenderers) {
      if (!renderer.isLayoutable || !renderer.innerApi) {
        continue;
      }

      const innerPanel = renderer.innerApi.getPanel(paneId);
      if (innerPanel) {
        const outer = this.dockview.getPanel(tabId);
        if (!outer) {
          continue;
        }

        return { outerPanel: outer as any, innerApi: renderer.innerApi, innerPanel: innerPanel as any };
      }
    }

    return null;
  }

  private updateOuterTabVisibility(): void {
    const panelCount = this.dockview?.panels.length ?? 0;
    this.workspaceHost.classList.toggle("single-tab", panelCount <= 1);
  }

  private attachResizeObserver(): void {
    if (!this.dockview) {
      return;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this.dockview) {
        return;
      }

      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        this.dockview.layout(width, height, true);
      }
    });

    this.resizeObserver.observe(this.workspaceHost);

    const rect = this.workspaceHost.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.dockview.layout(rect.width, rect.height, true);
    }
  }

  private handleTerminalEvent(event: TerminalRuntimeEvent): void {
    if (event.type === "state") {
      this.terminalRuntimes.set(event.runtime.runtimeId, event.runtime);
      return;
    }

    if (event.type === "removed") {
      this.terminalRuntimes.delete(event.runtimeId);
    }
  }
}
