import "@xterm/xterm/css/xterm.css";
import "dockview-core/dist/styles/dockview.css";
import "./styles.css";

import { createDockview, type DockviewApi } from "dockview-core";
import type { PropScope, ThemePreference } from "../../types/view";
import {
  asPaneId,
  asTabId,
  createPaneId,
  createTabId,
  createTerminalRuntimeId,
  type PaneId,
  type TabId,
  type TerminalRuntimeId
} from "../../lib/ids";
import { info } from "../../lib/logger";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../../types/terminal";
import type { BootstrapState } from "../model/bootstrap-state";
import { createPaneParams, isPaneParams, type PaneParams } from "../model/pane-params";
import { createSimpleTabParams, isLayoutableTabParams, type LayoutableTabParams } from "../model/tab-params";
import type {
  PaneCloseParams,
  PaneFocusParams,
  PaneMessageParams,
  PaneMessageResult,
  PaneOpenParams,
  PaneResult,
  PaneSplitParams,
  TabCloseParams,
  TabFocusParams,
  WorkspaceListResult,
  TabOpenParams,
  TabResult
} from "../model/workspace-types";
import { prop } from "../props/decorators";
import { PropertyOwnerBase } from "../props/property";
import { getHostRpc, sendRendererRpcMessage, setRendererRpcHandlers } from "../renderer/transport/host-rpc";
import type { PropertyChangeEvent } from "../../types/property";
import type { PaneCreateInput } from "../../types/pane";
import type { AppSummary } from "../model/workspace-types";
import { EXT_MANAGER_COMPONENT, EXT_MANAGER_TAB_ID, ExtManagerRenderer } from "./ext/ext-manager";
import { ExtensionSetupRegistry } from "./ext/extension-setup-registry";
import { titleFromLeaf } from "./helpers";
import { focusExistingSingletonView, handleAddPaneAction, type AddPaneContext } from "./add-pane-router";
import type { PaneRendererContext } from "./panes/pane-renderer";
import { PlaceholderRenderer } from "./panes/placeholder-renderer";
import { normalizeNullableString, PaneScope, type PaneScopeHost } from "./pane-scope";
import { WorkspaceScope, type WorkspaceScopeHost } from "./workspace-scope";
import { FlmuxTabRenderer } from "./tabs/flmux-tab-renderer";
import { TabRenderer } from "./tabs/tab-renderer";
import { getTheme, initTheme, setTheme } from "./theme";
import { attachWorkspaceResizeObserver, installWindowResizeHandles } from "./window-resize";
import {
  collectWorkspacePaneSummaries,
  collectWorkspaceTabSummaries,
  findActiveLayoutableTab,
  findWorkspacePane,
  focusWorkspacePane,
  getWorkspaceActivePaneId
} from "./workspace-layout";
import { captureWorkspaceFile, restoreWorkspaceFile } from "./workspace-persistence";
import type { RendererRpcRequestHandlers } from "../rpc/renderer-rpc";
import { saveSessionAs, showLoadSessionMenu, loadLastSession } from "./workspace-sessions";
import { mountWorkspaceTitlebar } from "./workspace-titlebar";

void bootstrapRenderer();

async function bootstrapRenderer(): Promise<void> {
  const bootstrap = await getHostRpc().request("bootstrap.get", undefined);
  initTheme(bootstrap.uiTheme);

  const root = document.querySelector<HTMLElement>("#app");
  if (!root) {
    throw new Error("Renderer root #app not found");
  }

  const app = new AppScope(root, bootstrap);
  setRendererRpcHandlers(app.createRendererRpcHandlers());
  await app.init();
}

class AppScope extends PropertyOwnerBase {
  private readonly hostRpc = getHostRpc();
  private readonly terminalRuntimes = new Map<TerminalRuntimeId, TerminalRuntimeSummary>();
  private readonly preCloseHooks = new Map<PaneId, () => void>();
  private readonly tabRenderers = new Map<string, TabRenderer>();
  private readonly workspaceScopes = new Map<TabId, WorkspaceScope>();
  private readonly paneScopes = new Map<PaneId, PaneScope>();
  private browserCdpBaseUrl: string | null = null;

  private readonly shell = document.createElement("div");
  private readonly titlebar = document.createElement("header");
  private readonly titlebarTitle = document.createElement("span");
  private readonly workspaceHost = document.createElement("section");

  private dockview: DockviewApi | null = null;
  private readonly setupRegistry = new ExtensionSetupRegistry();
  private resizeObserver: ResizeObserver | null = null;
  private cleanupWindowResizeHandles: (() => void) | null = null;
  private titlebarHandle: import("./workspace-titlebar").WorkspaceTitlebarHandle | null = null;
  private saveTimer = 0;
  private terminalEventUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly bootstrap: BootstrapState
  ) {
    super();
    this.browserCdpBaseUrl = this.bootstrap.browserAutomation.cdpBaseUrl;
    for (const runtime of this.bootstrap.liveTerminalRuntimes) {
      this.terminalRuntimes.set(runtime.runtimeId, runtime);
    }
    this.finalizeProperties();
  }

  protected override onPropertyChanged(key: string, value: unknown, previousValue: unknown): void {
    super.onPropertyChanged(key, value, previousValue);
    this.publishRendererPropertyChange({ scope: "app", targetId: null, key, value, previousValue, timestamp: Date.now() });
  }

  async init(): Promise<void> {
    this.shell.className = "app-shell";
    this.titlebar.className = "titlebar electrobun-webkit-app-region-drag";
    this.workspaceHost.className = "workspace-host dockview-theme-flmux";

    this.buildTitlebar();

    // Eager-load all extension setup modules before creating dockview
    // Runs after buildTitlebar so extensions can override the default title
    await this.setupRegistry.loadAll(
      this.bootstrap.extensionSetups,
      {
        get: (key: string) => this.get(key),
        set: (key: string, value: unknown) => this.set(key, value),
        list: () => this.values(),
        schema: () => this.schema()
      },
      this.bootstrap.extensionConfig
    );

    this.shell.append(this.titlebar, this.workspaceHost);
    this.root.replaceChildren(this.shell);

    const paneContext: PaneRendererContext = {
      workspaceRoot: this.bootstrap.cwd,
      webPort: this.bootstrap.webServerUrl ? Number(new URL(this.bootstrap.webServerUrl).port || 0) || null : null,
      getTabId: () => asTabId(""),
      openPane: (leaf, placement, options) => this.openPaneFromContext(leaf, placement, options),
      onPaneRemoved: (paneId, tabId) => this.handlePaneRemoved(paneId, tabId),
      getAppSummary: () => this.getSummary(),
      listTabs: () => this.listTabs().workspaces,
      getAppScope: () => this,
      getWorkspaceScope: (tabId) => this.getWorkspaceScope(tabId),
      getPaneScope: (paneId) => this.getPaneScope(paneId),
      onPaneReady: (paneId, tabId) => this.handlePaneReady(paneId, tabId),
      registerPreCloseHook: (paneId, hook) => this.preCloseHooks.set(paneId, hook),
      unregisterPreCloseHook: (paneId) => this.preCloseHooks.delete(paneId),
      firePreCloseHook: (paneId) => {
        this.preCloseHooks.get(paneId)?.();
        this.preCloseHooks.delete(paneId);
      }
    };

    this.dockview = createDockview(this.workspaceHost, {
      theme: { name: "flmux", className: "dockview-theme-flmux" },
      defaultTabComponent: "flmux-workspace-tab",
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
              register: (panelId, renderer) => this.registerTabRenderer(panelId, renderer),
              unregister: (panelId) => this.unregisterTabRenderer(panelId),
              onGroupAction: (action, panelId) => handleAddPaneAction(this.addPaneContext(), action, panelId),
              getTabIndex: (panelId) => this.dockview?.panels.findIndex((p) => p.id === panelId) ?? 0,
              setupRegistry: this.setupRegistry
            });
          }
          // Disabled/missing extension → placeholder
          const extId = options.name.split(":")[0] ?? options.name;
          return new PlaceholderRenderer(extId);
        }
        // Default: regular tab
        return new TabRenderer({
          paneContext,
          markDirty: () => this.queueSave(),
          register: (panelId, renderer) => this.registerTabRenderer(panelId, renderer),
          unregister: (panelId) => this.unregisterTabRenderer(panelId),
          onGroupAction: (action, panelId) => handleAddPaneAction(this.addPaneContext(), action, panelId),
          getTabIndex: (panelId) => this.dockview?.panels.findIndex((p) => p.id === panelId) ?? 0,
          setupRegistry: this.setupRegistry
        });
      },
      createTabComponent: () => new FlmuxTabRenderer()
    });

    this.dockview.onDidAddPanel(() => this.reparentOuterTabStrip());

    this.dockview.onDidLayoutChange(() => {
      this.queueSave();
    });
    this.dockview.onDidRemovePanel((panel) => {
      const paneId = asPaneId(panel.id);
      this.preCloseHooks.get(paneId)?.();
      this.preCloseHooks.delete(paneId);
      if (isLayoutableTabParams(panel.params)) {
        this.handleWorkspaceRemoved(asTabId(panel.id), panel.params.innerLayout);
        return;
      }
      if (isPaneParams(panel.params)) {
        this.handlePaneRemoved(asPaneId(panel.id), asTabId(panel.id));
        this.workspaceScopes.delete(asTabId(panel.id));
      }
    });
    this.resizeObserver = attachWorkspaceResizeObserver(this.dockview, this.workspaceHost);
    this.cleanupWindowResizeHandles = installWindowResizeHandles(this.hostRpc);
    this.terminalEventUnsubscribe =
      this.hostRpc.subscribe?.("terminal.event", (event) => this.handleTerminalEvent(event)) ?? null;
    window.addEventListener("flmux:layout-dirty", this.handleDirty);
    window.addEventListener("beforeunload", this.handleBeforeUnload);

    await this.restoreOrSeedLayout();
    this.reparentOuterTabStrip();
  }

  private buildTitlebar(): void {
    this.setTitle("flmux");
    this.titlebarHandle?.dispose();
    const launchers = this.setupRegistry.resolveTitlebarLaunchers([]);
    this.titlebarHandle = mountWorkspaceTitlebar({
      host: this.titlebar,
      titleElement: this.titlebarTitle,
      launchers: launchers.map((launcher) => ({
        icon: launcher.icon,
        tooltip: launcher.tooltip,
        onClick: () =>
          launcher.run({
            openPaneInNewWorkspace: async (leaf) => this.openPaneInNewWorkspace(leaf),
            openWorkspaceTab: (qualifiedId) => this.openRegisteredWorkspaceTab(qualifiedId)
          })
      })),
      onNewWorkspace: () => this.openNewWorkspace(),
      onSaveSessionAs: () => void saveSessionAs(this.hostRpc, this.dockview, this.tabRenderers),
      onShowLoadSessionMenu: (menu) => void showLoadSessionMenu(this.hostRpc, this.dockview, this.tabRenderers, menu, () => this.queueSave()),
      onLoadLastSession: () => void loadLastSession(this.hostRpc, this.dockview, this.tabRenderers, () => this.queueSave()),
      onOpenExtensionManager: () => this.openExtensionManager(),
      onSetTheme: (theme) => {
        setTheme(theme);
        void this.hostRpc.request("uiSettings.setTheme", { theme });
      },
      onWindowMinimize: () => void this.hostRpc.request("window.minimize", undefined),
      onWindowMaximize: () => void this.hostRpc.request("window.maximize", undefined),
      onWindowClose: () => void this.hostRpc.request("window.close", undefined)
    });
  }

  private reparentOuterTabStrip(): void {
    const host = this.titlebarHandle?.tabsHost;
    if (!host) return;

    const groupview = this.workspaceHost.querySelector(".dv-groupview");
    const tabStrip = groupview?.querySelector(":scope > .dv-tabs-and-actions-container");

    if (!tabStrip) return; // Already reparented or no group yet

    // Remove stale tab strip from previous group (e.g., after fromJSON)
    host.querySelector(".dv-tabs-and-actions-container")?.remove();
    host.appendChild(tabStrip);
  }

  private async openPaneInNewWorkspace(leaf: PaneCreateInput): Promise<void> {
    if (!this.dockview) {
      return;
    }

    const paneId = createPaneId(leaf.kind);
    const title = titleFromLeaf(leaf);
    const params = await this.createParamsForLeaf(leaf);
    const { tabId, renderer } = this.createLayoutableTab("Workspace");
    renderer.addPane(paneId, params, { initialTitle: title });
    this.dockview.getPanel(tabId)?.focus();
    this.queueSave();
  }

  @prop({ type: "string", description: "Window title" })
  getTitle(): string {
    return this.titlebarTitle.textContent?.trim() || "flmux";
  }

  @prop()
  setTitle(value: unknown): void {
    const nextTitle = String(value ?? "").trim();
    if (!nextTitle) {
      return;
    }
    this.titlebarTitle.textContent = nextTitle;
  }

  @prop({ type: "string", description: "Color theme preference", options: ["system", "dark", "light"] })
  getColorTheme(): string {
    return getTheme();
  }

  @prop()
  setColorTheme(value: unknown): void {
    const theme = String(value ?? "dark") as ThemePreference;
    if (theme !== "system" && theme !== "dark" && theme !== "light") return;
    setTheme(theme);
    void this.hostRpc.request("uiSettings.setTheme", { theme });
  }

  @prop("browser.cdpBaseUrl", {
    type: "string",
    nullable: true,
    readonly: true,
    description: "CDP discovery base URL"
  })
  getBrowserCdpBaseUrl(): string | null {
    return this.browserCdpBaseUrl;
  }

  @prop("browser.cdpBaseUrl", { readonly: true })
  setBrowserCdpBaseUrl(value: unknown): void {
    this.browserCdpBaseUrl = normalizeNullableString(value);
  }

  private getRendererForTab(tabId: TabId): TabRenderer | null {
    return this.tabRenderers.get(String(tabId)) ?? null;
  }

  private registerTabRenderer(panelId: string, renderer: TabRenderer): void {
    this.tabRenderers.set(panelId, renderer);
    const tabId = asTabId(panelId);
    if (this.workspaceScopes.has(tabId)) {
      return;
    }

    const host: WorkspaceScopeHost = {
      queueSave: () => this.queueSave(),
      publishSimplePaneTitleChange: (previousValue) => {
        this.getPaneScope(asPaneId(String(tabId)))?.notify("title", previousValue);
      }
    };
    this.workspaceScopes.set(
      tabId,
      new WorkspaceScope(host, tabId, renderer, this.publishRendererPropertyChange.bind(this))
    );
  }

  private unregisterTabRenderer(panelId: string): void {
    this.tabRenderers.delete(panelId);
  }

  private publishRendererPropertyChange(event: PropertyChangeEvent): void {
    sendRendererRpcMessage("workspace.props.changed", event);
  }

  private handlePaneRemoved(paneId: PaneId, _tabId: TabId): void {
    this.paneScopes.get(paneId)?.dispose();
    this.paneScopes.delete(paneId);
  }

  private handleWorkspaceRemoved(tabId: TabId, innerLayout?: unknown): void {
    const renderer = this.tabRenderers.get(String(tabId));
    const paneIds =
      renderer?.innerApi?.panels.map((panel) => asPaneId(panel.id)) ?? extractPaneIdsFromInnerLayout(innerLayout);
    for (const paneId of paneIds) {
      this.paneScopes.get(paneId)?.dispose();
      this.paneScopes.delete(paneId);
    }
    this.workspaceScopes.delete(tabId);
  }

  queryPropertyValue(scope: PropScope, targetId: string | null, key: string): { found: boolean; value: unknown } {
    const owner = this.resolveOwner(scope, targetId);
    if (!owner) return { found: false, value: undefined };
    const value = owner.get(key);
    return { found: value !== undefined, value };
  }

  queryPropertyValues(scope: PropScope, targetId: string | null): Record<string, unknown> {
    return this.resolveOwner(scope, targetId)?.values() ?? {};
  }

  queryPropertySchema(scope: PropScope, targetId: string | null): Record<string, unknown> {
    return this.resolveOwner(scope, targetId)?.schema() ?? {};
  }

  writePropertyValue(scope: PropScope, targetId: string | null, key: string, value: unknown): unknown {
    const owner = this.resolveOwner(scope, targetId);
    if (!owner) throw new Error(`Property not available: ${scope}.${key}`);
    return owner.set(key, value);
  }

  getTerminalRuntime(runtimeId: TerminalRuntimeId): TerminalRuntimeSummary | null {
    return this.terminalRuntimes.get(runtimeId) ?? null;
  }

  createRendererRpcHandlers(): RendererRpcRequestHandlers {
    return {
      "workspace.summary": () => this.getSummary(),
      "workspace.open": (params) => this.openPane(params),
      "workspace.focus": (params) => this.focusPane(params),
      "workspace.close": (params) => this.closePane(params),
      "workspace.split": (params) => this.splitPane(params),
      "workspace.tab.open": (params) => this.openTab(params),
      "workspace.tab.list": () => this.listTabs(),
      "workspace.tab.focus": (params) => this.focusTab(params),
      "workspace.tab.close": (params) => this.closeTab(params),
      "workspace.pane.message": (params) => this.sendPaneMessage(params),
      "workspace.props.get": (params) => ({
        ok: true as const,
        ...this.queryPropertyValue(params.scope, params.targetId ? String(params.targetId) : null, params.key)
      }),
      "workspace.props.list": (params) => ({
        ok: true as const,
        values: this.queryPropertyValues(params.scope, params.targetId ? String(params.targetId) : null)
      }),
      "workspace.props.schema": (params) => ({
        ok: true as const,
        properties: this.queryPropertySchema(params.scope, params.targetId ? String(params.targetId) : null)
      }),
      "workspace.props.set": (params) => ({
        ok: true as const,
        value: this.writePropertyValue(params.scope, params.targetId ? String(params.targetId) : null, params.key, params.value)
      })
    };
  }

  private resolveOwner(scope: PropScope, targetId: string | null): PropertyOwnerBase | null {
    if (scope === "app") return this;
    if (!targetId) throw new Error(`${scope}.props requires targetId`);
    if (scope === "workspace") return this.getWorkspaceScope(asTabId(targetId));
    return this.getPaneScope(asPaneId(targetId));
  }

  private getWorkspaceScope(tabId: TabId): WorkspaceScope | null {
    return this.workspaceScopes.get(tabId) ?? null;
  }

  private handlePaneReady(paneId: PaneId, tabId: TabId): void {
    if (this.paneScopes.has(paneId)) {
      return;
    }
    const renderer = this.getRendererForTab(tabId);
    if (!renderer) {
      return;
    }
    const host: PaneScopeHost = {
      queueSave: () => this.queueSave(),
      getPaneParams: () => renderer.getPaneParams(String(paneId)),
      updatePaneParams: (patch, options) => renderer.updatePaneParams(String(paneId), patch, options),
      getTerminalRuntime: (runtimeId) => this.getTerminalRuntime(runtimeId),
      publishSimpleWorkspaceTitleChange: (previousValue) => {
        this.getWorkspaceScope(tabId)?.notify("title", previousValue);
      }
    };
    this.paneScopes.set(
      paneId,
      new PaneScope(host, tabId, paneId, renderer, this.publishRendererPropertyChange.bind(this))
    );
  }

  private getPaneScope(paneId: PaneId): PaneScope | null {
    return this.paneScopes.get(paneId) ?? null;
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
          kind: "view",
          viewKey: tab.viewKey
        })
      });
    } else {
      const tabId = createTabId("ext");
      this.dockview.addPanel({
        id: tabId,
        component: qualifiedId,
        title: tab.title,
        params: createSimpleTabParams({
          kind: "view",
          viewKey: tab.viewKey
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

  private openNewWorkspace(): void {
    if (!this.dockview) {
      return;
    }

    const { tabId } = this.createLayoutableTab("Workspace");
    this.dockview.getPanel(tabId)?.focus();
    this.queueSave();
  }


  private async restoreOrSeedLayout(): Promise<void> {
    if (!this.dockview) {
      return;
    }

    const { file } = await this.hostRpc.request("flmuxLast.load", undefined);

    if (
      this.bootstrap.restoreLayout &&
      restoreWorkspaceFile(this.dockview, this.tabRenderers, file, () => this.queueSave())
    ) {
      return;
    }

    // Fresh start: always create one empty workspace tab and seed one terminal pane.
    const { renderer: layoutRenderer } = this.createLayoutableTab("Workspace");
    if (layoutRenderer) {
      const terminalPaneId = createPaneId("terminal");
      const terminalParams = await this.createParamsForLeaf({ kind: "terminal" });
      layoutRenderer.addPane(terminalPaneId, terminalParams, { initialTitle: "Terminal" });
    }
  }

  async openPane(params: PaneOpenParams): Promise<PaneResult> {
    return this.openLeaf(params.leaf, {
      referencePaneId: params.referencePaneId,
      direction: params.direction
    });
  }

  focusPane(params: PaneFocusParams): PaneResult {
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

  async closePane(params: PaneCloseParams): Promise<PaneResult> {
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

  sendPaneMessage(params: PaneMessageParams): PaneMessageResult {
    const found = findWorkspacePane(this.dockview, this.tabRenderers, params.paneId);
    if (!found) {
      return { ok: true, delivered: false };
    }

    const tabId = asTabId(found.outerPanel.id);
    this.getWorkspaceScope(tabId)?.emit(params.eventType, params.data, {
      sourcePaneId: params.paneId,
      tabId,
      timestamp: Date.now()
    });
    return { ok: true, delivered: true };
  }

  async splitPane(params: PaneSplitParams): Promise<PaneResult> {
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
      title: this.getTitle(),
      activePaneId: getWorkspaceActivePaneId(this.dockview, this.tabRenderers),
      panes: collectWorkspacePaneSummaries(this.dockview, this.tabRenderers),
      webServerUrl: this.bootstrap.webServerUrl,
      browserAutomation: {
        cdpBaseUrl: this.bootstrap.browserAutomation.cdpBaseUrl
      }
    };
  }

  listTabs(): WorkspaceListResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    return { workspaces: collectWorkspaceTabSummaries(this.dockview, this.tabRenderers) };
  }

  openTab(params: TabOpenParams): TabResult {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const title = params.title ?? (params.layoutMode === "layoutable" ? "Workspace" : "Tab");

    if (params.layoutMode === "layoutable") {
      const { tabId } = this.createLayoutableTab(title, {
        customTitle: params.title?.trim() || undefined
      });
      this.dockview.getPanel(tabId)?.focus();
      this.queueSave();
      return { ok: true, tabId };
    } else {
      throw new Error("tab.open for simple/stack tabs requires a pane — use pane.open instead");
    }
  }

  focusTab(params: TabFocusParams): TabResult {
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

  closeTab(params: TabCloseParams): TabResult {
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

  private async openPaneFromContext(
    leaf: PaneCreateInput,
    placement?: { referencePaneId?: PaneId; direction?: "within" | "left" | "right" | "above" | "below" },
    options?: { singleton?: boolean }
  ): Promise<PaneResult> {
    const referencePaneId = placement?.referencePaneId;
    if (options?.singleton && leaf.kind === "view") {
      const focused = focusExistingSingletonView(this.addPaneContext(), referencePaneId, leaf.viewKey);
      if (focused) {
        const activePaneId = getWorkspaceActivePaneId(this.dockview, this.tabRenderers);
        if (!activePaneId) {
          throw new Error("Failed to resolve active pane after focusing singleton pane");
        }
        return {
          ok: true,
          paneId: activePaneId,
          activePaneId
        };
      }
    }

    return this.openLeaf(leaf, {
      referencePaneId,
      direction: placement?.direction
    });
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
    renderer.addPane(paneId, params, { initialTitle: title });
    this.dockview.getPanel(layoutTabId)?.focus();
    this.queueSave();
    return this.makePaneResult(paneId);
  }

  private async createParamsForLeaf(leaf: PaneCreateInput): Promise<PaneParams> {
    if (leaf.kind === "terminal") {
      const runtimeId = createTerminalRuntimeId();
      const startupCommands = leaf.startupCommands
        ?.map((command) => command.trim())
        .filter((command) => command.length > 0);
      return createPaneParams("terminal", {
        runtimeId,
        cwd: leaf.cwd ?? this.bootstrap.cwd,
        shell: leaf.shell ?? null,
        renderer: leaf.renderer ?? this.bootstrap.terminalRendererDefault,
        startupCommands: startupCommands?.length ? startupCommands : undefined
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

    return createPaneParams("view", { viewKey: leaf.viewKey });
  }

  private addPaneContext(): AddPaneContext {
    return {
      dockview: this.dockview,
      tabRenderers: this.tabRenderers,
      setupRegistry: this.setupRegistry,
      openLeaf: (leaf, options) => this.openLeaf(leaf, options),
      openPaneFromContext: (leaf, placement, options) => this.openPaneFromContext(leaf, placement, options),
      openRegisteredWorkspaceTab: (id) => this.openRegisteredWorkspaceTab(id)
    };
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

    const renderer = this.tabRenderers.get(found.outerPanel.id);
    if (!renderer) {
      throw new Error(`pane.open renderer not found for outer tab: ${found.outerPanel.id}`);
    }

    renderer.addPane(paneId, params, {
      initialTitle: title,
      position: {
        referencePanel: referencePaneId,
        direction: direction ?? "within"
      }
    });
    found.outerPanel.focus();
    this.queueSave();
    return this.makePaneResult(paneId);
  }

  private getOrCreateTargetLayoutableTab(): { tabId: TabId; renderer: TabRenderer } {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const activeLayoutable = findActiveLayoutableTab(this.dockview, this.tabRenderers);
    if (activeLayoutable) {
      return {
        tabId: asTabId(activeLayoutable.tabId),
        renderer: activeLayoutable.renderer
      };
    }

    return this.createLayoutableTab("Workspace");
  }

  private createLayoutableTab(
    title: string,
    options: { customTitle?: string } = {}
  ): { tabId: TabId; renderer: TabRenderer } {
    if (!this.dockview) {
      throw new Error("Dockview is not ready");
    }

    const tabId = createTabId("layout");
    const customTitle = options.customTitle?.trim() || null;
    this.dockview.addPanel({
      id: tabId,
      component: "flmux-tab",
      title: customTitle ?? title,
      params: {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null,
        customTitle
      } as LayoutableTabParams
    });

    const renderer = this.tabRenderers.get(tabId);
    if (!renderer) {
      throw new Error("Failed to create layoutable tab");
    }
    if (customTitle) {
      renderer.setWorkspaceTitle(customTitle);
    }

    return { tabId, renderer };
  }

  queueSave(): void {
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
    const file = captureWorkspaceFile(this.dockview, this.tabRenderers, windowFrame);

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
    this.cleanupWindowResizeHandles?.();
    this.cleanupWindowResizeHandles = null;
    this.titlebarHandle?.dispose();
    this.titlebarHandle = null;
    this.terminalEventUnsubscribe?.();
    this.terminalEventUnsubscribe = null;
    this.preCloseHooks.clear();
    this.paneScopes.clear();
    this.workspaceScopes.clear();
    this.disposeEmitter();
  };

  private makePaneResult(paneId: PaneId): PaneResult {
    return {
      ok: true,
      paneId,
      activePaneId: getWorkspaceActivePaneId(this.dockview, this.tabRenderers)
    };
  }

  private handleTerminalEvent(event: TerminalRuntimeEvent): void {
    if (event.type === "state") {
      const previous = this.terminalRuntimes.get(event.runtime.runtimeId) ?? null;
      this.terminalRuntimes.set(event.runtime.runtimeId, event.runtime);
      this.notifyTerminalRuntimeScopes(event.runtime.runtimeId, previous, event.runtime);
      return;
    }

    if (event.type === "removed") {
      const previous = this.terminalRuntimes.get(event.runtimeId) ?? null;
      this.terminalRuntimes.delete(event.runtimeId);
      this.notifyTerminalRuntimeScopes(event.runtimeId, previous, null);
    }
  }

  private notifyTerminalRuntimeScopes(
    runtimeId: TerminalRuntimeId,
    previous: TerminalRuntimeSummary | null,
    next: TerminalRuntimeSummary | null
  ): void {
    for (const pane of this.paneScopes.values()) {
      if (pane.tracksTerminalRuntime(runtimeId)) {
        pane.notifyTerminalRuntimeChanged(previous, next);
      }
    }
  }
}

function extractPaneIdsFromInnerLayout(layout: unknown): PaneId[] {
  if (!layout || typeof layout !== "object") {
    return [];
  }
  const panels = (layout as { panels?: Record<string, unknown> }).panels;
  if (!panels || typeof panels !== "object") {
    return [];
  }
  return Object.keys(panels).map((panelId) => asPaneId(panelId));
}
