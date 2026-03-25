import "@xterm/xterm/css/xterm.css";
import "dockview-core/dist/styles/dockview.css";
import "./styles.css";

import { type AddPanelOptions, createDockview, type DockviewApi } from "dockview-core";
import type {
  AppSummary,
  BrowserNewParams,
  BrowserPaneResult,
  BrowserPaneInfo,
  BrowserPaneListResult,
  PaneCloseParams,
  PaneCreateInput,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitParams,
  TabCloseParams,
  TabFocusParams,
  TabListResult,
  TabOpenParams,
  TabResult
} from "../shared/app-rpc";
import type { BootstrapState } from "../shared/bootstrap-state";
import { createFlmuxLastFile, type FlmuxLastFile, type WindowFrame } from "../shared/flmux-last";
import {
  asPaneId,
  asTabId,
  createPaneId,
  createTabId,
  createTerminalRuntimeId,
  type PaneId,
  type TerminalRuntimeId
} from "../shared/ids";
import { info } from "../shared/logger";
import { createPaneParams, isPaneParams, type PaneParams } from "../shared/pane-params";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../shared/rpc";
import { createSimpleTabParams, type LayoutableTabParams } from "../shared/tab-params";
import { AppOwner, EventBus } from "./event-bus";
import { EXT_MANAGER_COMPONENT, EXT_MANAGER_TAB_ID, ExtManagerRenderer } from "./ext-manager";
import { ExtensionSetupRegistry } from "./extension-setup-registry";
import { PlaceholderRenderer } from "./placeholder-renderer";
import {
  isV1Layout,
  migrateV1Layout,
  sanitizeSerializedLayout,
  titleFromLeaf
} from "./helpers";
import { getHostRpc, setRendererRpcHandlers } from "./lib/host-rpc";
import type { PaneRendererContext } from "./pane-renderer";
import { TabRenderer } from "./tab-renderer";
import {
  collectWorkspaceBrowserPaneInfos,
  collectWorkspacePaneSummaries,
  collectWorkspaceTabSummaries,
  findActiveLayoutableTab,
  findWorkspaceActiveInnerPaneId,
  findWorkspacePane,
  focusWorkspacePane,
  getWorkspaceActivePaneId
} from "./workspace-layout";

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
    "workspace.pane.message": (params) => app.paneMessageFromRpc(params),
    "workspace.browser.list": () => app.browserListFromRpc(),
    "workspace.browser.new": (params) => app.browserNewFromRpc(params)
  });
}

class WorkspaceApp {
  private readonly hostRpc = getHostRpc();
  private readonly eventBus = new EventBus();
  private readonly browserPaneInfos = new Map<PaneId, BrowserPaneInfo>();
  private readonly terminalRuntimes = new Map<TerminalRuntimeId, TerminalRuntimeSummary>();
  private readonly preCloseHooks = new Map<PaneId, () => void>();
  private readonly tabRenderers = new Map<string, TabRenderer>();

  private readonly shell = document.createElement("div");
  private readonly titlebar = document.createElement("header");
  private readonly titlebarTitle = document.createElement("span");
  private readonly workspaceHost = document.createElement("section");

  private dockview: DockviewApi | null = null;
  private readonly setupRegistry = new ExtensionSetupRegistry();
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

    // Eager-load all extension setup modules before creating dockview
    await this.setupRegistry.loadAll(this.bootstrap.extensions);

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
      },
      setBrowserPaneInfo: (paneId, info) => {
        if (info) {
          this.browserPaneInfos.set(paneId, info);
        } else {
          this.browserPaneInfos.delete(paneId);
        }
      }
    };

    this.dockview = createDockview(this.workspaceHost, {
      className: "dockview-theme-flmux",
      defaultRenderer: "always",
      createComponent: (options) => {
        // Built-in singleton: Extension Manager
        if (options.name === EXT_MANAGER_COMPONENT) {
          return new ExtManagerRenderer(this.hostRpc);
        }
        // Extension workspace tab (registered or disabled/missing)
        if (this.setupRegistry.isExtensionTabId(options.name)) {
          const tab = this.setupRegistry.findWorkspaceTab(options.name);
          if (tab) {
            // Registered extension tab → extension pane in simple tab
            return new TabRenderer({
              paneContext,
              markDirty: () => this.queueSave(),
              register: (panelId, renderer) => this.tabRenderers.set(panelId, renderer),
              unregister: (panelId) => this.tabRenderers.delete(panelId),
              onGroupAction: (action, panelId) => this.handleInnerGroupAction(action, panelId),
              getTabIndex: (panelId) => this.dockview?.panels.findIndex((p) => p.id === panelId) ?? 0,
              setupRegistry: this.setupRegistry
            });
          }
          // Disabled/missing extension → placeholder
          const extId = options.name.split(":")[0];
          return new PlaceholderRenderer(extId);
        }
        // Default: regular tab
        return new TabRenderer({
          paneContext,
          markDirty: () => this.queueSave(),
          register: (panelId, renderer) => this.tabRenderers.set(panelId, renderer),
          unregister: (panelId) => this.tabRenderers.delete(panelId),
          onGroupAction: (action, panelId) => this.handleInnerGroupAction(action, panelId),
          getTabIndex: (panelId) => this.dockview?.panels.findIndex((p) => p.id === panelId) ?? 0,
          setupRegistry: this.setupRegistry
        });
      }
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
    this.setupResizeHandles();
    this.terminalEventUnsubscribe =
      this.hostRpc.subscribe?.("terminal.event", (event) => this.handleTerminalEvent(event)) ?? null;
    window.addEventListener("flmux:layout-dirty", this.handleDirty);
    window.addEventListener("beforeunload", this.handleBeforeUnload);

    // Listen for app:title events from extensions
    this.eventBus.on(
      AppOwner.paneId,
      AppOwner.tabId,
      "app:title",
      (event) => {
        const title = (event.data as { title?: string })?.title;
        if (typeof title === "string") this.titlebarTitle.textContent = title;
      },
      { global: true }
    );

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
      this.buildSessionMenu(),
      this.buildSettingsMenu()
    );

    // Right: window controls (no-drag)
    const right = document.createElement("div");
    right.className = "titlebar-window-controls electrobun-webkit-app-region-no-drag";
    right.append(
      this.makeWindowBtn("\u2500", "Minimize", () => void this.hostRpc.request("window.minimize", undefined)),
      this.makeWindowBtn("\u25A1", "Maximize", () => void this.hostRpc.request("window.maximize", undefined)),
      this.makeWindowBtn(
        "\u2715",
        "Close",
        () => void this.hostRpc.request("window.close", undefined),
        "window-btn-close"
      )
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
      makeItem("Load Last Session", () => void this.loadLastSession())
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

  private buildSettingsMenu(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "titlebar-menu-wrapper";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "titlebar-btn";
    trigger.textContent = "\u2699\uFE0F";
    trigger.title = "Settings";

    const menu = document.createElement("div");
    menu.className = "titlebar-menu";
    menu.hidden = true;

    const extBtn = document.createElement("button");
    extBtn.type = "button";
    extBtn.className = "titlebar-menu-item";
    extBtn.textContent = "Extensions";
    extBtn.addEventListener("click", () => {
      menu.hidden = true;
      this.openExtensionManager();
    });
    menu.append(extBtn);

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

  private openExtensionManager(): void {
    this.openSingletonWorkspaceTab(EXT_MANAGER_TAB_ID, EXT_MANAGER_COMPONENT, "Extensions");
  }

  /** Open a workspace tab by registered qualifiedId. Handles singleton focus-or-create. */
  private openRegisteredWorkspaceTab(qualifiedId: string): void {
    if (!this.dockview) return;

    const tab = this.setupRegistry.findWorkspaceTab(qualifiedId);
    if (!tab) return;

    if (tab.singleton) {
      this.openSingletonWorkspaceTab(qualifiedId, qualifiedId, tab.title, {
        ...createSimpleTabParams({
          kind: "extension",
          extensionId: tab.extensionId,
          contributionId: tab.contributionId
        })
      });
    } else {
      const tabId = createTabId("ext");
      this.dockview.addPanel({
        id: tabId,
        component: qualifiedId,
        title: tab.title,
        params: createSimpleTabParams({
          kind: "extension",
          extensionId: tab.extensionId,
          contributionId: tab.contributionId
        })
      });
      this.dockview.getPanel(tabId)?.focus();
    }
  }

  private openSingletonWorkspaceTab(
    id: string,
    component: string,
    title: string,
    params?: Record<string, unknown>
  ): void {
    if (!this.dockview) return;

    const existing = this.dockview.getPanel(id);
    if (existing) {
      existing.focus();
      return;
    }

    this.dockview.addPanel({
      id,
      component,
      title,
      params: params ?? { tabKind: "tab", layoutMode: "simple" }
    });
    this.dockview.getPanel(id)?.focus();
  }

  /** Create a new layoutable tab with a fresh terminal inside. */
  private async openNewTerminalTab(): Promise<void> {
    if (!this.dockview) return;
    const { tabId: layoutTabId, renderer } = this.createLayoutableTab("Workspace");
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
    const { tabId: layoutTabId, renderer } = this.createLayoutableTab("Browser");
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

    const windowFrame = await this.hostRpc.request("window.frame.get", undefined);
    const file = this.captureWorkspaceFile(windowFrame);
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
    const { file } = await this.hostRpc.request("session.load", { name });
    await this.restoreWorkspaceFile(file);
  }

  private async loadLastSession(): Promise<void> {
    const { file } = await this.hostRpc.request("flmuxLast.load", undefined);
    await this.restoreWorkspaceFile(file);
  }

  private async restoreOrSeedLayout(): Promise<void> {
    if (!this.dockview) {
      return;
    }

    const { file } = await this.hostRpc.request("flmuxLast.load", undefined);

    if (this.bootstrap.restoreLayout && (await this.restoreWorkspaceFile(file))) {
      return;
    }

    // Fresh start: single layoutable tab with one terminal
    const { renderer: layoutRenderer } = this.createLayoutableTab("Workspace");
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

    const found = findWorkspacePane(this.dockview, this.tabRenderers, params.paneId);
    if (!found) {
      throw new Error(`pane.focus target pane not found: ${params.paneId}`);
    }

    focusWorkspacePane(this.dockview, this.tabRenderers, params.paneId);
    return this.makePaneResult(params.paneId);
  }

  async closePaneFromRpc(params: PaneCloseParams): Promise<PaneResult> {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const found = findWorkspacePane(this.dockview, this.tabRenderers, params.paneId);
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
    const found = findWorkspacePane(this.dockview, this.tabRenderers, params.paneId);
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

    return {
      activePaneId: getWorkspaceActivePaneId(this.dockview, this.tabRenderers),
      panes: collectWorkspacePaneSummaries(this.dockview, this.tabRenderers),
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

    return { tabs: collectWorkspaceTabSummaries(this.dockview, this.tabRenderers) };
  }

  browserListFromRpc(): BrowserPaneListResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    return {
      ok: true,
      panes: collectWorkspaceBrowserPaneInfos(this.dockview, this.tabRenderers, this.browserPaneInfos)
    };
  }

  async browserNewFromRpc(params: BrowserNewParams): Promise<BrowserPaneResult> {
    const placement = this.resolveBrowserNewPlacement(params);
    const result = await this.openLeaf(
      {
        kind: "browser",
        url: params.url
      },
      placement
    );
    return { ok: true, paneId: result.paneId };
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

    if (options.referencePaneId) {
      return this.insertPaneRelativeToReference(paneId, title, params, options.referencePaneId, options.direction);
    }

    const { tabId: layoutTabId, renderer } = this.getOrCreateTargetLayoutableTab();
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
        mode: leaf.mode ?? "filetree"
      });
    }

    return createPaneParams("extension", {
      extensionId: leaf.extensionId,
      contributionId: leaf.contributionId
    });
  }

  private handleInnerGroupAction(action: string, activePanelId: string | null): void {
    const ref = activePanelId ? asPaneId(activePanelId) : undefined;

    // Check extension-registered group actions
    const extAction = this.setupRegistry.findGroupAction(action);
    if (extAction) {
      const found = ref ? findWorkspacePane(this.dockview, this.tabRenderers, ref) : null;
      const tabId = found ? asTabId(found.outerPanel.id) : asTabId("");
      extAction.run({
        activePaneId: ref ?? null,
        tabId,
        openPane: (leaf: PaneCreateInput, placement?, options?) => {
          if (options?.singleton && leaf.kind === "extension") {
            const focused = this.focusExistingSingletonPane(ref, leaf.extensionId, leaf.contributionId);
            if (focused) return;
          }
          void this.openLeaf(leaf, {
            referencePaneId: placement?.referencePaneId ?? ref,
            direction: placement?.direction
          });
        },
        openWorkspaceTab: (id: string) => {
          const qualifiedId = `${extAction.qualifiedId.split(":")[0]}:${id}`;
          this.openRegisteredWorkspaceTab(qualifiedId);
        }
      });
      return;
    }

    // Builtin actions
    switch (action) {
      case "terminal":
        void this.openLeaf({ kind: "terminal" }, ref ? { referencePaneId: ref, direction: "within" } : {});
        break;
      case "browser":
        void this.browserNewFromRpc({ senderPaneId: ref, placement: "auto" });
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

  /** Find and focus an existing pane matching extensionId+contributionId in the same inner dockview. */
  private focusExistingSingletonPane(
    referencePaneId: PaneId | undefined,
    extensionId: string,
    contributionId: string
  ): boolean {
    const found = referencePaneId ? findWorkspacePane(this.dockview, this.tabRenderers, referencePaneId) : null;
    const innerApi = found
      ? this.tabRenderers.get(found.outerPanel.id)?.innerApi
      : null;
    if (!innerApi) return false;

    for (const panel of innerApi.panels) {
      const params = panel.params as Record<string, unknown>;
      if (
        params.kind === "extension" &&
        params.extensionId === extensionId &&
        params.contributionId === contributionId
      ) {
        panel.focus();
        return true;
      }
    }
    return false;
  }

  private async splitFromPane(
    referencePaneId: PaneId | undefined,
    direction: "left" | "right" | "above" | "below"
  ): Promise<void> {
    const activeInnerPaneId = findWorkspaceActiveInnerPaneId(this.tabRenderers);
    const resolvedReferencePaneId = referencePaneId ?? activeInnerPaneId;
    if (!resolvedReferencePaneId) {
      await this.openLeaf({ kind: "terminal" });
      return;
    }
    const cwd = this.getTerminalCwd(
      findWorkspacePane(this.dockview, this.tabRenderers, resolvedReferencePaneId)?.innerPanel?.params ?? undefined
    );
    await this.openLeaf({ kind: "terminal", cwd }, { referencePaneId: resolvedReferencePaneId, direction });
  }

  private resolveBrowserNewPlacement(params: BrowserNewParams): {
    referencePaneId?: PaneId;
    direction?: "within" | "left" | "right" | "above" | "below";
  } {
    const requested = params.placement ?? "auto";
    const senderPaneId = params.senderPaneId;

    if (!senderPaneId) {
      return {};
    }

    if (requested !== "auto") {
      return {
        referencePaneId: senderPaneId,
        direction: requested
      };
    }

    return {
      referencePaneId: senderPaneId,
      direction: this.resolveAutoBrowserDirection(senderPaneId)
    };
  }

  private resolveAutoBrowserDirection(sourcePaneId: PaneId): "right" | "above" {
    const found = findWorkspacePane(this.dockview, this.tabRenderers, sourcePaneId);
    const sourceParams = found?.innerPanel?.params ?? found?.outerPanel?.params;
    if (!isPaneParams(sourceParams) || sourceParams.kind !== "terminal") {
      return "right";
    }

    const runtime = this.terminalRuntimes.get(sourceParams.runtimeId);
    if (!runtime) {
      return "right";
    }

    return runtime.cols >= runtime.rows * 1.2 ? "right" : "above";
  }

  private insertPaneRelativeToReference(
    paneId: PaneId,
    title: string,
    params: PaneParams,
    referencePaneId: PaneId,
    direction?: "within" | "left" | "right" | "above" | "below"
  ): PaneResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const found = findWorkspacePane(this.dockview, this.tabRenderers, referencePaneId);
    if (!found) {
      throw new Error(`pane.open reference pane not found: ${referencePaneId}`);
    }
    if (!found.innerApi) {
      throw new Error(`pane.open reference pane is not in a layoutable tab: ${referencePaneId}`);
    }

    found.innerApi.addPanel({
      id: paneId,
      component: "flmux-pane",
      title,
      params,
      position: {
        referencePanel: referencePaneId,
        direction: direction ?? "within"
      }
    } as AddPanelOptions<PaneParams>);
    found.outerPanel.focus();
    this.queueSave();
    return this.makePaneResult(paneId);
  }

  private getOrCreateTargetLayoutableTab(): { tabId: string; renderer: TabRenderer } {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const activeLayoutable = findActiveLayoutableTab(this.dockview, this.tabRenderers);
    if (activeLayoutable) {
      return activeLayoutable;
    }

    return this.createLayoutableTab("Workspace");
  }

  private createLayoutableTab(title: string): { tabId: string; renderer: TabRenderer } {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const tabId = createTabId("layout");
    this.dockview.addPanel({
      id: tabId,
      component: "flmux-tab",
      title,
      params: {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null
      } as LayoutableTabParams
    });

    const renderer = this.tabRenderers.get(tabId);
    if (!renderer) {
      throw new Error("Failed to create layoutable tab");
    }

    return { tabId, renderer };
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

    const windowFrame = await this.hostRpc.request("window.frame.get", undefined);
    const file = this.captureWorkspaceFile(windowFrame);

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
      activePaneId: getWorkspaceActivePaneId(this.dockview, this.tabRenderers)
    };
  }

  private captureWorkspaceFile(windowFrame?: WindowFrame): FlmuxLastFile {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    for (const renderer of this.tabRenderers.values()) {
      renderer.flushInnerLayout();
    }

    return createFlmuxLastFile({
      activePaneId: getWorkspaceActivePaneId(this.dockview, this.tabRenderers),
      workspaceLayout: sanitizeSerializedLayout(this.dockview.toJSON()).layout,
      window: windowFrame
    });
  }

  private async restoreWorkspaceFile(file: Pick<FlmuxLastFile, "workspaceLayout" | "activePaneId"> | null): Promise<boolean> {
    if (!this.dockview || !file?.workspaceLayout) {
      return false;
    }

    try {
      const source = isV1Layout(file.workspaceLayout) ? migrateV1Layout(file.workspaceLayout) : file.workspaceLayout;
      const { changed, layout } = sanitizeSerializedLayout(source);
      this.dockview.fromJSON(layout);
      if (file.activePaneId) {
        focusWorkspacePane(this.dockview, this.tabRenderers, file.activePaneId);
      }
      if (this.dockview.panels.length === 0) {
        return false;
      }
      if (changed) {
        this.queueSave();
      }
      return true;
    } catch {
      return false;
    }
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

  private setupResizeHandles(): void {
    const runtime = window as Window & { __electrobun?: unknown; __electrobunWindowId?: unknown };
    const isElectrobun =
      typeof runtime.__electrobun !== "undefined" || typeof runtime.__electrobunWindowId === "number";
    if (!isElectrobun) return;

    const edges = ["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const;

    for (const edge of edges) {
      const el = document.createElement("div");
      el.className = `resize-handle resize-${edge}`;
      document.body.appendChild(el);

      el.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);

        const startX = e.screenX;
        const startY = e.screenY;

        void this.hostRpc.request("window.frame.get", undefined).then((initial) => {
          let rafId = 0;
          let latestX = startX;
          let latestY = startY;

          const applyResize = (): void => {
            rafId = 0;
            const dx = latestX - startX;
            const dy = latestY - startY;
            let x = initial.x;
            let y = initial.y;
            let w = initial.width;
            let h = initial.height;

            if (edge.includes("e")) w += dx;
            if (edge.includes("w")) {
              x += dx;
              w -= dx;
            }
            if (edge.includes("s")) h += dy;
            if (edge.includes("n")) {
              y += dy;
              h -= dy;
            }

            if (w < 400) {
              if (edge.includes("w")) x = initial.x + initial.width - 400;
              w = 400;
            }
            if (h < 300) {
              if (edge.includes("n")) y = initial.y + initial.height - 300;
              h = 300;
            }

            void this.hostRpc.request("window.frame.set", { x, y, width: w, height: h, maximized: false });
          };

          const onMove = (ev: PointerEvent): void => {
            latestX = ev.screenX;
            latestY = ev.screenY;
            if (!rafId) rafId = requestAnimationFrame(applyResize);
          };

          const onUp = (): void => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("lostpointercapture", onUp);
            if (rafId) {
              cancelAnimationFrame(rafId);
              applyResize();
            }
          };

          el.addEventListener("pointermove", onMove);
          el.addEventListener("pointerup", onUp);
          el.addEventListener("lostpointercapture", onUp);
        });
      });
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
