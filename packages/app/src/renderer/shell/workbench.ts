import "dockview-core/dist/styles/dockview.css";
import {
  createDockview,
  themeAbyss,
  type CreateComponentOptions,
  type DockviewApi,
  type IContentRenderer,
  type SerializedDockview
} from "dockview-core";
import "../styles.css";
import { setupDropIndicatorMasks } from "../maskHelper";
import { createSessionHost } from "../sessionHost";
import { createTerminalHost } from "../terminalHost";
import { TerminalCoordinator } from "../terminal/terminalCoordinator";
import { createShellModel } from "./model";
import {
  PaneRegistry,
  type PaneDescriptor,
  type PaneRecord,
  type PaneWorkspaceContext,
  createPaneRecord,
  createPaneSnapshot,
  isBrowserPaneRecord,
  isTerminalPaneRecord,
  normalizeRestoredPaneParams,
  resolvePaneCreateParams,
  resolvePaneTitle,
  serializePaneParams
} from "./paneRegistry";
import { registerBuiltinPaneDescriptors } from "./builtinPaneDescriptors";
import type {
  AppStatusSnapshot,
  NewPaneInput,
  PanePlacement,
  ShellModelAPI,
  ShellModelHost,
  ShellResolvedPanePathMount,
  ShellPaneSnapshot,
  WorkspaceBus,
  WorkspaceBusEvent
} from "./types";
import type { FlmuxSessionSnapshot, FlmuxWorkspaceSessionSnapshot } from "../../shared/session";
import type { FlmuxHostRequestProxy, FlmuxRendererBootstrapConfig } from "../../shared/rendererBridge";
import type { TerminalRuntimeSummary } from "../../shared/terminal";
import { resolveTerminalCwdFromRoot } from "../../shared/terminalPath";
import { createWorkspaceBus } from "./workspaceBus";

type WorkspaceSeed = {
  id: string;
  title: string;
  defaultFixture: string;
  rootDirName: string;
};

type WorkspaceRecord = {
  id: string;
  title: string;
  defaultTitle: string;
  defaultFixture: string;
  rootDir: string;
  surface: HTMLElement;
  bus: WorkspaceBus;
  paneRecords: Map<string, PaneRecord>;
  api: DockviewApi | null;
};

const WORKSPACE_SEEDS: WorkspaceSeed[] = [
  { id: "workspace.alpha", title: "Workspace Alpha", defaultFixture: "counter", rootDirName: "workspace-alpha" },
  { id: "workspace.beta", title: "Workspace Beta", defaultFixture: "form", rootDirName: "workspace-beta" }
];

export class FlmuxWorkbench implements ShellModelHost {
  readonly shellModel: ShellModelAPI;

  private readonly appTitleEl = document.getElementById("app-title")!;
  private readonly workspaceTitleEl = document.getElementById("workspace-title")!;
  private readonly runtimeBadgeEl = document.getElementById("runtime-badge")!;
  private readonly workspaceSwitcherEl = document.getElementById("workspace-switcher")!;
  private readonly shellEl = document.querySelector<HTMLElement>(".dockview-shell")!;
  private readonly browserPanelTemplate = document.getElementById("browser-panel-tpl") as HTMLTemplateElement;
  private readonly sessionHost: ReturnType<typeof createSessionHost>;
  private readonly terminalHost: ReturnType<typeof createTerminalHost>;
  private readonly terminalCoordinator: TerminalCoordinator<WorkspaceRecord>;
  private readonly paneRegistry = new PaneRegistry();

  private readonly workspaces = new Map<string, WorkspaceRecord>();

  private activeWorkspaceId = WORKSPACE_SEEDS[0].id;
  private appTitle = "flmux";
  private runtimeLabel = "booting";
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;

  constructor(private readonly config: FlmuxRendererBootstrapConfig, hostProxy: FlmuxHostRequestProxy) {
    this.sessionHost = createSessionHost(hostProxy);
    this.terminalHost = createTerminalHost(hostProxy);
    this.terminalCoordinator = new TerminalCoordinator<WorkspaceRecord>({
      terminalHost: this.terminalHost,
      resolveTerminalCwd: resolveTerminalCwdFromRoot,
      findWorkspaceByPaneId: (paneId) => this.findWorkspaceByPaneId(paneId),
      onRuntimeStateChange: (workspace, paneId, state) => this.applyTerminalRuntimeStateChange(workspace, paneId, state)
    });
    registerBuiltinPaneDescriptors(this.paneRegistry, {
      fixtureUrl: (fixture) => this.fixtureUrl(fixture),
      requireBrowserUrl: (value) => this.requireBrowserUrl(value),
      resolveTerminalCwd: resolveTerminalCwdFromRoot,
      serializeBrowserUrl: (url) => this.serializeBrowserUrl(url)
    });
    this.shellModel = createShellModel({
      host: this,
      terminal: {
        createRuntime: (paneId, input) => this.terminalCoordinator.createRuntime(paneId, input),
        writeRuntime: (paneId, input) => this.terminalCoordinator.writeRuntime(paneId, input),
        resizeRuntime: (paneId, input) => this.terminalCoordinator.resizeRuntime(paneId, input),
        readHistory: (paneId, input) => this.terminalCoordinator.readHistory(paneId, input),
        killRuntime: (paneId) => this.terminalCoordinator.killRuntime(paneId)
      },
      browser: {
        setPaneUrl: (paneId, url) => this.setBrowserPaneUrl(paneId, url)
      }
    });
  }

  registerExternalPane(descriptor: PaneDescriptor) {
    const rawDescriptor = descriptor as unknown as Record<string, unknown>;
    const legacyHookKeys = [
      "createParams",
      "getTitle",
      "normalizeRestoredParams",
      "createRecord",
      "serializeParams",
      "createSnapshot"
    ].filter((key) => key in rawDescriptor);
    if (legacyHookKeys.length > 0) {
      console.warn(
        `pane descriptor '${descriptor.kind}' uses legacy flat hooks (${legacyHookKeys.join(", ")}); move them under lifecycle/persistence`
      );
    }

    this.paneRegistry.register(descriptor);
  }

  async start() {
    this.runtimeLabel = "local-http preload ok";
    this.buildWorkspaces();
    this.bindTopbar();
    await this.restoreSessionOrDefaults();
    await this.terminalCoordinator.restoreTerminals(this.workspaces.values());
    this.renderChrome();
    setupDropIndicatorMasks();
    this.sessionPersistenceEnabled = true;
    window.addEventListener("pagehide", () => {
      void this.flushSessionSave({ preferBeacon: true });
    });
    this.scheduleSessionSave();
  }

  getAppStatus(): AppStatusSnapshot {
    return {
      title: this.appTitle,
      origin: this.config.appOrigin,
      runtimeLabel: this.runtimeLabel
    };
  }

  setAppTitle(title: string): AppStatusSnapshot {
    this.appTitle = title;
    this.renderChrome();
    this.scheduleSessionSave();
    return this.getAppStatus();
  }

  getWorkspaceStatus() {
    const workspace = this.getCurrentWorkspace();
    return {
      id: workspace.id,
      title: workspace.title,
      activePaneId: workspace.api?.activePanel?.id ?? null,
      paneCount: workspace.paneRecords.size
    };
  }

  hasPaneKind(kind: string) {
    return this.paneRegistry.get(kind) !== undefined;
  }

  setWorkspaceTitle(title: string) {
    const workspace = this.getCurrentWorkspace();
    workspace.title = title;
    this.renderWorkspaceSwitcher();
    this.renderChrome();
    this.scheduleSessionSave();
    return this.getWorkspaceStatus();
  }

  listPanes(): ShellPaneSnapshot[] {
    const workspace = this.getCurrentWorkspace();
    return [...workspace.paneRecords.keys()].map((paneId) => this.mustGetPaneSnapshot(workspace, paneId));
  }

  getPane(paneId: string): ShellPaneSnapshot | undefined {
    const workspace = this.getCurrentWorkspace();
    if (!workspace.paneRecords.has(paneId)) {
      return undefined;
    }

    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  createPane(input: NewPaneInput): ShellPaneSnapshot {
    const workspace = this.getCurrentWorkspace();
    const pane = this.addPane(workspace, input);
    this.scheduleSessionSave();
    return pane;
  }

  async closePane(paneId: string) {
    const workspace = this.findWorkspaceByPaneId(paneId) ?? this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    await this.terminalCoordinator.killAttachedRuntime(workspace, paneId, record);
    record.panel.api.close();
    return { paneId, closed: true };
  }

  setPaneTitle(paneId: string, title: string): ShellPaneSnapshot {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    record.panel.api.setTitle(title);
    this.renderChrome();
    this.scheduleSessionSave();
    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  private setBrowserPaneUrl(paneId: string, url: string): ShellPaneSnapshot {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    if (!isBrowserPaneRecord(record)) {
      throw new Error(`Pane '${paneId}' is not a browser pane`);
    }

    const nextUrl = this.requireBrowserUrl(url);
    record.url = nextUrl;
    record.panel.update({ params: { url: nextUrl } });
    this.scheduleSessionSave();
    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  getPaneParams(paneId: string) {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    return cloneJsonObject(record.panel.toJSON().params);
  }

  setPaneParams(paneId: string, nextParams: Record<string, unknown>) {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    const clonedParams = cloneJsonObject(nextParams) ?? {};
    record.panel.update({ params: clonedParams });
    this.scheduleSessionSave();
    return clonedParams;
  }

  patchPaneParams(paneId: string, patch: Record<string, unknown>) {
    return this.setPaneParams(paneId, {
      ...(this.getPaneParams(paneId) ?? {}),
      ...(cloneJsonObject(patch) ?? {})
    });
  }

  getPanePathMount(paneId: string): ShellResolvedPanePathMount | undefined {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    const descriptor = this.requirePaneDescriptor(record.kind);
    const mount = descriptor.pathMount;
    if (!mount) {
      return undefined;
    }

    const createContext = () => ({
      paneId,
      workspace: this.toPaneWorkspaceContext(workspace),
      record,
      currentParams: this.getPaneParams(paneId),
      setParams: (nextParams: Record<string, unknown>) => this.setPaneParams(paneId, nextParams),
      patchParams: (patch: Record<string, unknown>) => this.patchPaneParams(paneId, patch)
    });

    return {
      mountKey: mount.mountKey,
      getStateSnapshot: () => mount.getStateSnapshot?.(createContext()),
      canSetStatePath: mount.canSetStatePath
        ? (relativePath) => mount.canSetStatePath!(createContext(), relativePath)
        : undefined,
      setState: mount.setState
        ? (relativePath, value) => mount.setState!(createContext(), relativePath, value)
        : undefined,
      getStatusSnapshot: () => mount.getStatusSnapshot?.(createContext())
    };
  }

  publishWorkspaceEvent(input: { topic: string; sourcePaneId: string; payload: unknown }): WorkspaceBusEvent {
    const workspace = this.findWorkspaceByPaneId(input.sourcePaneId);
    if (!workspace) {
      throw new Error(`Pane '${input.sourcePaneId}' does not belong to a known workspace`);
    }

    const event: WorkspaceBusEvent = {
      topic: input.topic,
      sourcePaneId: input.sourcePaneId,
      payload: input.payload,
      workspaceId: workspace.id,
      timestamp: Date.now()
    };

    workspace.bus.publish(event);
    return event;
  }

  private requirePaneDescriptor(kind: string) {
    const descriptor = this.paneRegistry.get(kind);
    if (!descriptor) {
      throw new Error(`Unknown panel component '${kind}'`);
    }

    return descriptor;
  }

  private toPaneWorkspaceContext(workspace: WorkspaceRecord): PaneWorkspaceContext {
    return {
      id: workspace.id,
      rootDir: workspace.rootDir,
      defaultFixture: workspace.defaultFixture,
      bus: workspace.bus
    };
  }

  private buildWorkspaces() {
    this.shellEl.replaceChildren();

    for (const seed of WORKSPACE_SEEDS) {
      const surface = document.createElement("div");
      surface.className = "workspace-surface";
      surface.dataset.workspaceId = seed.id;
      this.shellEl.append(surface);

      this.workspaces.set(seed.id, {
        id: seed.id,
        title: seed.title,
        defaultTitle: seed.title,
        defaultFixture: seed.defaultFixture,
        rootDir: joinPath(this.config.projectDir, seed.rootDirName),
        surface,
        bus: createWorkspaceBus(seed.id),
        paneRecords: new Map(),
        api: null
      });
    }

    this.renderWorkspaceSwitcher();
  }

  private bindTopbar() {
    document.querySelectorAll<HTMLButtonElement>("[data-fixture]").forEach((button) => {
      button.addEventListener("click", () => {
        const fixture = button.dataset.fixture!;
        void this.shellModel.pathCall("/panes/new", {
          kind: "browser",
          title: fixtureLabel(fixture),
          url: this.fixtureUrl(fixture),
          place: "right"
        });
      });
    });

    document.querySelector<HTMLButtonElement>('[data-action="new-cowsay"]')!.addEventListener("click", () => {
      void this.shellModel.pathCall("/panes/new", {
        kind: "cowsay",
        place: "right"
      });
    });

    document.querySelector<HTMLButtonElement>('[data-action="new-inspector"]')!.addEventListener("click", () => {
      void this.shellModel.pathCall("/panes/new", {
        kind: "inspector",
        place: "right"
      });
    });

    document.querySelector<HTMLButtonElement>('[data-action="new-scratchpad"]')!.addEventListener("click", () => {
      void this.shellModel.pathCall("/panes/new", {
        kind: "scratchpad",
        place: "right"
      });
    });

    document.querySelector<HTMLButtonElement>('[data-action="new-terminal"]')!.addEventListener("click", () => {
      void this.shellModel.pathCall("/panes/new", {
        kind: "terminal",
        cwd: ".",
        place: "right",
        autoCreate: true
      });
    });

    document.querySelector<HTMLButtonElement>('[data-action="reset"]')!.addEventListener("click", () => {
      this.resetWorkspace(this.getCurrentWorkspace());
    });
  }

  private activateWorkspace(workspaceId: string, options: { persist?: boolean } = {}) {
    const workspace = this.requireWorkspace(workspaceId);
    this.activeWorkspaceId = workspaceId;

    for (const record of this.workspaces.values()) {
      record.surface.classList.toggle("workspace-surface--active", record.id === workspaceId);
    }

    this.ensureWorkspaceInitialized(workspace);
    this.renderWorkspaceSwitcher();
    this.renderChrome();
    if (options.persist !== false) {
      this.scheduleSessionSave();
    }

    requestAnimationFrame(() => {
      const width = workspace.surface.clientWidth;
      const height = workspace.surface.clientHeight;
      if (workspace.api && width > 0 && height > 0) {
        workspace.api.layout(width, height, true);
      }
    });
  }

  private ensureWorkspaceInitialized(workspace: WorkspaceRecord) {
    if (workspace.api) {
      return;
    }

    workspace.api = createDockview(workspace.surface, {
      theme: themeAbyss,
      disableFloatingGroups: true,
      createComponent: (options) => this.createPanelRenderer(workspace, options)
    });

    this.bindDockviewEvents(workspace);
  }

  private bindDockviewEvents(workspace: WorkspaceRecord) {
    const api = workspace.api!;

    api.onDidActivePanelChange(() => {
      if (workspace.id === this.activeWorkspaceId) {
        this.renderChrome();
      }
      this.scheduleSessionSave();
    });

    api.onDidAddPanel(() => {
      if (workspace.id === this.activeWorkspaceId) {
        this.renderChrome();
      }
      this.scheduleSessionSave();
    });

    api.onDidRemovePanel((panel) => {
      const record = workspace.paneRecords.get(panel.id);
      if (record) {
        void this.terminalCoordinator.killAttachedRuntime(workspace, panel.id, record).catch((error) => {
          console.warn("failed to clean up terminal runtime for removed pane", panel.id, error);
        });
      }

      workspace.paneRecords.delete(panel.id);
      if (workspace.id === this.activeWorkspaceId) {
        this.renderChrome();
      }
      this.scheduleSessionSave();
    });
  }

  private createPanelRenderer(workspace: WorkspaceRecord, options: CreateComponentOptions): IContentRenderer {
    const descriptor = this.requirePaneDescriptor(String(options.name));
    return descriptor.createRenderer({
      workspace: this.toPaneWorkspaceContext(workspace),
      options,
      runtime: {
        shellModel: this.shellModel,
        browserPanelTemplate: this.browserPanelTemplate,
        terminalHost: this.terminalHost,
        normalizeBrowserUrl: (value) => this.normalizeBrowserUrl(value),
        onBrowserUrlChange: (paneId, url) => this.handleBrowserUrlChange(workspace, paneId, url),
        onTerminalRuntimeStateChange: (paneId, state) => this.terminalCoordinator.applyRuntimeStateChange(paneId, state)
      }
    });
  }

  private resetWorkspace(workspace: WorkspaceRecord) {
    if (!workspace.api) {
      return;
    }

    workspace.api.clear();
    workspace.paneRecords.clear();
    workspace.title = workspace.defaultTitle;

    const cowsay = this.addPane(workspace, { kind: "cowsay", title: "Cowsay" });
    this.addPane(workspace, {
      kind: "browser",
      title: fixtureLabel(workspace.defaultFixture),
      url: this.fixtureUrl(workspace.defaultFixture),
      place: "right",
      referencePaneId: cowsay.id
    });

    workspace.api.getPanel(cowsay.id)?.group.api.setSize({ width: 440 });
    this.renderWorkspaceSwitcher();
    if (workspace.id === this.activeWorkspaceId) {
      this.renderChrome();
    }
    this.scheduleSessionSave();
  }

  private addPane(workspace: WorkspaceRecord, input: NewPaneInput): ShellPaneSnapshot {
    const descriptor = this.requirePaneDescriptor(input.kind);
    const paneId = createPaneId();
    const workspaceContext = this.toPaneWorkspaceContext(workspace);
    const params = resolvePaneCreateParams({
      descriptor,
      workspace: workspaceContext,
      input,
      fallbackParams: cloneJsonObject(input.params)
    });
    const title = resolvePaneTitle({
      descriptor,
      workspace: workspaceContext,
      input,
      params,
      fallbackTitle: input.title?.trim() ?? humanizePaneKind(input.kind)
    });

    const panel = workspace.api!.addPanel({
      id: paneId,
      component: descriptor.kind,
      title,
      params,
      position: this.resolvePanePosition(workspace, input)
    });

    const record = createPaneRecord({
      descriptor,
      workspace: workspaceContext,
      panel,
      params
    });

    workspace.paneRecords.set(paneId, record);
    if (workspace.id === this.activeWorkspaceId) {
      this.renderChrome();
    }
    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  private resolvePanePosition(workspace: WorkspaceRecord, input: NewPaneInput) {
    const referencePanel =
      (input.referencePaneId && workspace.api!.getPanel(input.referencePaneId)) ?? workspace.api!.activePanel;
    const direction = normalizeDirection(input.place);

    if (!referencePanel || !direction) {
      return undefined;
    }

    return {
      referencePanel,
      direction
    };
  }

  private getCurrentWorkspace() {
    return this.requireWorkspace(this.activeWorkspaceId);
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }

    return workspace;
  }

  private findWorkspaceByPaneId(paneId: string) {
    for (const workspace of this.workspaces.values()) {
      if (workspace.paneRecords.has(paneId)) {
        return workspace;
      }
    }

    return null;
  }

  private requirePaneRecord(workspace: WorkspaceRecord, paneId: string): PaneRecord {
    const record = workspace.paneRecords.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found in workspace '${workspace.id}'`);
    }

    return record;
  }

  private mustGetPaneSnapshot(workspace: WorkspaceRecord, paneId: string): ShellPaneSnapshot {
    const record = this.requirePaneRecord(workspace, paneId);
    const isActive = workspace.api?.activePanel?.id === paneId;
    const title = record.panel.title ?? "Untitled";
    const descriptor = this.requirePaneDescriptor(record.kind);
    return createPaneSnapshot({
      descriptor,
      paneId,
      title,
      active: isActive,
      record
    });
  }

  private renderWorkspaceSwitcher() {
    this.workspaceSwitcherEl.replaceChildren(
      ...[...this.workspaces.values()].map((workspace) => {
        const button = document.createElement("button");
        button.className = "workspace-chip";
        button.dataset.active = String(workspace.id === this.activeWorkspaceId);
        button.textContent = workspace.title;
        button.addEventListener("click", () => this.activateWorkspace(workspace.id));
        return button;
      })
    );
  }

  private renderChrome() {
    const workspace = this.getCurrentWorkspace();
    this.appTitleEl.textContent = this.appTitle;
    this.workspaceTitleEl.textContent = `${workspace.title} · ${workspace.id} · ${workspace.paneRecords.size} panes`;
    this.runtimeBadgeEl.textContent = this.runtimeLabel;
    document.title = `${this.appTitle} / ${workspace.title}`;
  }

  private handleBrowserUrlChange(workspace: WorkspaceRecord, paneId: string, url: string) {
    const record = workspace.paneRecords.get(paneId);
    if (!record || !isBrowserPaneRecord(record)) {
      return;
    }

    record.url = url;
    record.panel.update({ params: { url } });
    this.scheduleSessionSave();
  }

  private applyTerminalRuntimeStateChange(
    workspace: WorkspaceRecord,
    paneId: string,
    state: { cwd: string; rootKey: string | null; runtimeId: string | null; summary: TerminalRuntimeSummary | null }
  ) {
    const record = workspace.paneRecords.get(paneId);
    if (!record || !isTerminalPaneRecord(record)) {
      return;
    }

    record.cwd = state.cwd;
    record.rootKey = state.rootKey;
    record.runtimeId = state.runtimeId;
    record.summary = state.summary;
    if (workspace.id === this.activeWorkspaceId) {
      this.renderChrome();
    }
    this.scheduleSessionSave();
  }

  private async restoreSessionOrDefaults() {
    for (const workspace of this.workspaces.values()) {
      this.ensureWorkspaceInitialized(workspace);
    }

    this.sessionPersistenceSuppressed = true;
    try {
      const snapshot = await this.sessionHost.load();
      this.appTitle = snapshot?.appTitle ?? this.appTitle;

      for (const workspace of this.workspaces.values()) {
        const workspaceSnapshot = snapshot?.workspaces[workspace.id];
        if (workspaceSnapshot) {
          this.restoreWorkspace(workspace, workspaceSnapshot);
          continue;
        }

        this.resetWorkspace(workspace);
      }

      const activeWorkspaceId =
        snapshot?.activeWorkspaceId && this.workspaces.has(snapshot.activeWorkspaceId)
          ? snapshot.activeWorkspaceId
          : WORKSPACE_SEEDS[0].id;
      this.activateWorkspace(activeWorkspaceId, { persist: false });
    } finally {
      this.sessionPersistenceSuppressed = false;
    }
  }

  private restoreWorkspace(workspace: WorkspaceRecord, snapshot: FlmuxWorkspaceSessionSnapshot) {
    if (!workspace.api) {
      return;
    }

    workspace.api.clear();
    workspace.paneRecords.clear();
    workspace.title = snapshot.title.trim() || workspace.defaultTitle;

    if (!snapshot.layout) {
      return;
    }

    try {
      workspace.api.fromJSON(this.prepareWorkspaceLayoutForRestore(workspace, snapshot.layout as SerializedDockview));
      this.rehydrateWorkspacePaneRecords(workspace);
    } catch (error) {
      console.warn(`failed to restore workspace '${workspace.id}' from saved session`, error);
      this.resetWorkspace(workspace);
    }
  }

  private rehydrateWorkspacePaneRecords(workspace: WorkspaceRecord) {
    if (!workspace.api) {
      return;
    }

    workspace.paneRecords.clear();
    const workspaceContext = this.toPaneWorkspaceContext(workspace);
    for (const panel of workspace.api.panels) {
      const panelState = panel.toJSON();
      const kind = panelState.contentComponent as string | undefined;
      if (!kind) {
        throw new Error(`Restored panel '${panel.id}' is missing contentComponent`);
      }
      const descriptor = this.requirePaneDescriptor(kind);
      const params = cloneJsonObject(panelState.params);
      workspace.paneRecords.set(panel.id, createPaneRecord({
        descriptor,
        workspace: workspaceContext,
        panel,
        params
      }));
    }
  }

  private prepareWorkspaceLayoutForRestore(workspace: WorkspaceRecord, layout: SerializedDockview) {
    const next = cloneLayout(layout);
    const workspaceContext = this.toPaneWorkspaceContext(workspace);
    for (const panelState of Object.values(next.panels ?? {})) {
      const kind = panelState.contentComponent as string | undefined;
      if (!kind) {
        throw new Error("Persisted panel is missing contentComponent");
      }
      const descriptor = this.requirePaneDescriptor(kind);
      panelState.params = normalizeRestoredPaneParams({
        descriptor,
        workspace: workspaceContext,
        params: cloneJsonObject(panelState.params)
      });
    }

    return next;
  }

  private serializeSessionSnapshot(): FlmuxSessionSnapshot {
    return {
      version: 1,
      appTitle: this.appTitle,
      activeWorkspaceId: this.activeWorkspaceId,
      workspaces: Object.fromEntries(
        [...this.workspaces.values()].map((workspace) => [
          workspace.id,
          {
            title: workspace.title,
            layout: workspace.api ? this.serializeWorkspaceLayout(workspace) : null
          } satisfies FlmuxWorkspaceSessionSnapshot
        ])
      )
    };
  }

  private serializeWorkspaceLayout(workspace: WorkspaceRecord): SerializedDockview {
    const layout = cloneLayout(workspace.api!.toJSON());
    const workspaceContext = this.toPaneWorkspaceContext(workspace);
    for (const [panelId, panelState] of Object.entries(layout.panels ?? {})) {
      const record = workspace.paneRecords.get(panelId);
      if (!record) {
        continue;
      }
      const descriptor = this.requirePaneDescriptor(record.kind);
      panelState.params = serializePaneParams({
        descriptor,
        workspace: workspaceContext,
        record,
        currentParams: cloneJsonObject(panelState.params)
      });
    }

    return layout;
  }

  private scheduleSessionSave() {
    if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
      return;
    }

    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
    }

    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      void this.sessionHost.save(this.serializeSessionSnapshot()).catch((error) => {
        console.warn("failed to persist flmux session snapshot", error);
      });
    }, 250);
  }

  private normalizeBrowserUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.includes("://")) {
      return trimmed;
    }

    if (trimmed.startsWith("/")) {
      return `${this.config.appOrigin}${trimmed}`;
    }

    return `${prefersHttpScheme(trimmed) ? "http" : "https"}://${trimmed}`;
  }

  private requireBrowserUrl(value: string): string {
    const normalized = this.normalizeBrowserUrl(value);
    if (!normalized) {
      throw new Error("Browser url is required");
    }

    return normalized;
  }

  private fixtureUrl(fixture: string) {
    return `${this.config.fixtureBaseUrl}/${fixture}`;
  }

  private async flushSessionSave(options: { preferBeacon?: boolean } = {}) {
    if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
      return;
    }

    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }

    const snapshot = this.serializeSessionSnapshot();
    if (options.preferBeacon && this.saveSnapshotViaBeacon(snapshot)) {
      return;
    }

    await this.sessionHost.save(snapshot);
  }

  private saveSnapshotViaBeacon(snapshot: FlmuxSessionSnapshot) {
    try {
      const payload = JSON.stringify(snapshot);
      const endpoint = `${this.config.appOrigin}/api/session/save`;
      const body = new Blob([payload], {
        type: "application/json"
      });

      if (typeof navigator.sendBeacon === "function") {
        return navigator.sendBeacon(endpoint, body);
      }

      void fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: payload,
        keepalive: true
      });
      return true;
    } catch {
      return false;
    }
  }

  private serializeBrowserUrl(url: string) {
    try {
      const parsed = new URL(url);
      if (parsed.origin === this.config.appOrigin) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {}

    return url;
  }
}

function createPaneId() {
  return `pane_${crypto.randomUUID()}`;
}

function normalizeDirection(place: PanePlacement | undefined) {
  return place ?? "within";
}

function fixtureLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinPath(basePath: string, childPath: string) {
  const normalizedBase = basePath.replace(/[\\/]+$/, "");
  return `${normalizedBase}/${childPath}`;
}

function cloneJsonObject(value: unknown) {
  return value && typeof value === "object"
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : undefined;
}

function cloneLayout<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function humanizePaneKind(kind: string) {
  return kind
    .split(/[./_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Pane";
}

function prefersHttpScheme(value: string) {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("localhost") ||
    lower.startsWith("127.") ||
    lower.startsWith("[::1]") ||
    lower.startsWith("0.0.0.0") ||
    lower.startsWith("10.") ||
    lower.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower) ||
    lower.endsWith(".local")
  );
}
