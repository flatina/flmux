import "dockview-core/dist/styles/dockview.css";
import {
  createDockview,
  themeAbyss,
  type CreateComponentOptions,
  type DockviewApi,
  type DockviewPanelApi,
  type GroupPanelPartInitParameters,
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
  ShellPaneRecordSnapshot,
  ShellResolvedPanePathMount,
  ShellResolvedPaneSubtreeMount,
  ScopedPropertyTarget,
  WorkspaceBus,
  WorkspaceBusEvent
} from "./types";
import type { FlmuxSessionSnapshot, FlmuxWorkspaceSessionSnapshot } from "../../shared/session";
import type { FlmuxHostRequestProxy, FlmuxRendererBootstrapConfig } from "../../shared/rendererBridge";
import { getFlmuxRendererLifecyclePolicy } from "../../shared/runtimeMode";
import type { TerminalRuntimeSummary } from "../../shared/terminal";
import { resolveTerminalCwdFromRoot } from "../../shared/terminalPath";
import { createWorkspaceBus } from "./workspaceBus";

type WorkspaceDescriptor = {
  id: string;
  title: string;
};

type WorkspaceRecord = {
  id: string;
  title: string;
  defaultTitle: string;
  defaultBrowserPath: string;
  rootDir: string;
  bus: WorkspaceBus;
  paneRecords: Map<string, PaneRecord>;
  outerPanelApi: DockviewPanelApi | null;
  innerApi: DockviewApi | null;
  innerHost: HTMLElement | null;
  innerResizeObserver: ResizeObserver | null;
  pendingInnerLayout: SerializedDockview | null;
};

const OUTER_WORKSPACE_COMPONENT = "workspace";

export class FlmuxWorkbench implements ShellModelHost {
  readonly shellModel: ShellModelAPI;
  private readonly lifecyclePolicy: ReturnType<typeof getFlmuxRendererLifecyclePolicy>;

  private readonly shellEl = document.querySelector<HTMLElement>(".dockview-shell")!;
  private readonly browserPanelTemplate = document.getElementById("browser-panel-tpl") as HTMLTemplateElement;
  private readonly sessionHost: ReturnType<typeof createSessionHost>;
  private readonly terminalHost: ReturnType<typeof createTerminalHost>;
  private readonly terminalCoordinator: TerminalCoordinator<WorkspaceRecord>;
  private readonly paneRegistry = new PaneRegistry();

  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private outerApi: DockviewApi | null = null;

  private appTitle = "flmux";
  private runtimeLabel = "booting";
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;
  private reseedingDefault = false;

  constructor(private readonly config: FlmuxRendererBootstrapConfig, hostProxy: FlmuxHostRequestProxy) {
    this.lifecyclePolicy = getFlmuxRendererLifecyclePolicy(config.mode);
    this.sessionHost = createSessionHost(hostProxy);
    this.terminalHost = createTerminalHost(hostProxy);
    this.terminalCoordinator = new TerminalCoordinator<WorkspaceRecord>({
      terminalHost: this.terminalHost,
      resolveTerminalCwd: resolveTerminalCwdFromRoot,
      findWorkspaceByPaneId: (paneId) => this.findWorkspaceByPaneId(paneId),
      onRuntimeStateChange: (workspace, paneId, state) => this.applyTerminalRuntimeStateChange(workspace, paneId, state)
    });
    registerBuiltinPaneDescriptors(this.paneRegistry, {
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
    this.runtimeLabel = this.config.mode === "desktop" ? "desktop local-http preload ok" : "web local-http attach";
    this.initializeOuterShell();

    if (this.lifecyclePolicy.restoreSession) {
      await this.restoreSessionOrDefaults();
    } else {
      await this.initializeDefaultWorkspaceSet();
    }

    if (this.lifecyclePolicy.restoreTerminals) {
      await this.terminalCoordinator.restoreTerminals(this.workspaces.values());
    }

    this.updateDocumentTitle();
    setupDropIndicatorMasks();

    if (this.lifecyclePolicy.persistSession) {
      this.sessionPersistenceEnabled = true;
      window.addEventListener("pagehide", () => {
        void this.flushSessionSave({ preferBeacon: true });
      });
      this.scheduleSessionSave();
    }
  }

  getAppStatus(): AppStatusSnapshot {
    return {
      title: this.appTitle,
      origin: this.config.appOrigin,
      runtimeLabel: this.runtimeLabel
    };
  }

  listWorkspaces() {
    return [...this.workspaces.values()].map((workspace) => this.toWorkspaceStatus(workspace));
  }

  async createWorkspace(input: { title?: string } = {}) {
    const workspace = this.createWorkspaceRecord(this.allocateWorkspaceDescriptor(input.title));
    this.mountOuterPanel(workspace, { focus: true });
    await this.resetWorkspace(workspace);
    return this.toWorkspaceStatus(workspace);
  }

  getWorkspaceStatus() {
    return this.toWorkspaceStatus(this.getCurrentWorkspace());
  }

  setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown) {
    const nextValue = asNonEmptyString(value, `${target.scope} property '${key}'`);

    if (key !== "title") {
      throw new Error(`Unsupported scoped property '${key}'`);
    }

    switch (target.scope) {
      case "app":
        this.appTitle = nextValue;
        this.updateDocumentTitle();
        this.scheduleSessionSave();
        return { value: this.appTitle };
      case "workspace": {
        const workspace = target.workspaceId ? this.requireWorkspace(target.workspaceId) : this.getCurrentWorkspace();
        workspace.title = nextValue;
        workspace.outerPanelApi?.setTitle(nextValue);
        if (workspace.id === this.getActiveWorkspaceId()) {
          this.updateDocumentTitle();
        }
        this.scheduleSessionSave();
        return { value: workspace.title };
      }
      case "pane": {
        const workspace = this.findWorkspaceByPaneId(target.paneId);
        if (!workspace) {
          throw new Error(`Pane '${target.paneId}' does not belong to a known workspace`);
        }

        const record = this.requirePaneRecord(workspace, target.paneId);
        record.panel.api.setTitle(nextValue);
        this.scheduleSessionSave();
        return { value: record.panel.title ?? nextValue };
      }
    }
  }

  hasPaneKind(kind: string) {
    return this.paneRegistry.get(kind) !== undefined;
  }

  listPanes(): ShellPaneRecordSnapshot[] {
    const workspace = this.getCurrentWorkspace();
    return [...workspace.paneRecords.keys()].map((paneId) => this.mustGetPaneSnapshot(workspace, paneId));
  }

  getPane(paneId: string): ShellPaneRecordSnapshot | undefined {
    const workspace = this.getCurrentWorkspace();
    if (!workspace.paneRecords.has(paneId)) {
      return undefined;
    }

    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  createPane(input: NewPaneInput): ShellPaneRecordSnapshot {
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

  getPaneSubtreeMounts(paneId: string): ShellResolvedPaneSubtreeMount[] {
    const workspace = this.getCurrentWorkspace();
    const record = this.requirePaneRecord(workspace, paneId);
    const descriptor = this.requirePaneDescriptor(record.kind);
    return (descriptor.subtreeMounts ?? []).map((mount) => {
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

  attachInnerDockview(workspace: WorkspaceRecord, host: HTMLElement, outerApi: DockviewPanelApi) {
    workspace.outerPanelApi = outerApi;
    workspace.innerHost = host;

    const innerApi = createDockview(host, {
      theme: themeAbyss,
      disableFloatingGroups: true,
      createComponent: (options) => this.createInnerPanelRenderer(workspace, options)
    });
    workspace.innerApi = innerApi;

    this.bindInnerDockviewEvents(workspace);

    if (workspace.pendingInnerLayout) {
      try {
        innerApi.fromJSON(this.prepareWorkspaceLayoutForRestore(workspace, workspace.pendingInnerLayout));
        this.rehydrateWorkspacePaneRecords(workspace);
      } catch (error) {
        console.warn(`failed to restore workspace '${workspace.id}' from saved session`, error);
        workspace.paneRecords.clear();
        innerApi.clear();
      }
      workspace.pendingInnerLayout = null;
    }

    const layoutInner = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (workspace.innerApi && width > 0 && height > 0) {
        workspace.innerApi.layout(width, height, true);
      }
    };

    workspace.innerResizeObserver = new ResizeObserver(() => layoutInner());
    workspace.innerResizeObserver.observe(host);
    requestAnimationFrame(layoutInner);
  }

  detachInnerDockview(workspace: WorkspaceRecord) {
    workspace.innerResizeObserver?.disconnect();
    workspace.innerResizeObserver = null;
    workspace.innerApi?.dispose();
    workspace.innerApi = null;
    workspace.innerHost = null;
    workspace.outerPanelApi = null;
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
      defaultBrowserPath: workspace.defaultBrowserPath,
      bus: workspace.bus
    };
  }

  private initializeOuterShell() {
    this.shellEl.replaceChildren();
    this.workspaces.clear();

    this.outerApi = createDockview(this.shellEl, {
      theme: themeAbyss,
      disableFloatingGroups: true,
      defaultRenderer: "always",
      createComponent: (options) => this.createOuterPanelRenderer(options)
    });

    this.outerApi.onDidActivePanelChange(() => {
      this.updateDocumentTitle();
      this.scheduleSessionSave();
    });
    this.outerApi.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
    this.outerApi.onDidRemovePanel((panel) => {
      void this.handleWorkspacePanelRemoved(panel.id);
    });

    const layoutOuter = () => {
      const width = this.shellEl.clientWidth;
      const height = this.shellEl.clientHeight;
      if (this.outerApi && width > 0 && height > 0) {
        this.outerApi.layout(width, height, true);
      }
    };

    new ResizeObserver(() => layoutOuter()).observe(this.shellEl);
    requestAnimationFrame(layoutOuter);
  }

  private createOuterPanelRenderer(options: CreateComponentOptions): IContentRenderer {
    if (String(options.name) !== OUTER_WORKSPACE_COMPONENT) {
      throw new Error(`Unknown outer component '${options.name}'`);
    }

    return new WorkspaceOuterPanelRenderer(options.id, this);
  }

  private createInnerPanelRenderer(workspace: WorkspaceRecord, options: CreateComponentOptions): IContentRenderer {
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

  getWorkspaceForOuterPanel(panelId: string): WorkspaceRecord | null {
    return this.workspaces.get(panelId) ?? null;
  }

  private bindInnerDockviewEvents(workspace: WorkspaceRecord) {
    const api = workspace.innerApi!;

    api.onDidActivePanelChange(() => {
      this.scheduleSessionSave();
    });
    api.onDidAddPanel(() => {
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
      this.scheduleSessionSave();
    });
    api.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
  }

  private mountOuterPanel(workspace: WorkspaceRecord, options: { focus?: boolean } = {}) {
    if (!this.outerApi) {
      throw new Error("Outer dockview is not initialized");
    }
    if (this.outerApi.getPanel(workspace.id)) {
      return;
    }

    const panel = this.outerApi.addPanel({
      id: workspace.id,
      component: OUTER_WORKSPACE_COMPONENT,
      title: workspace.title
    });
    if (options.focus) {
      panel.focus();
    }
  }

  private async handleWorkspacePanelRemoved(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      const paneIds = [...workspace.paneRecords.keys()];
      for (const paneId of paneIds) {
        const record = workspace.paneRecords.get(paneId);
        if (record) {
          await this.terminalCoordinator.killAttachedRuntime(workspace, paneId, record).catch((error) => {
            console.warn("failed to clean up terminal runtime for workspace close", paneId, error);
          });
        }
      }
      workspace.paneRecords.clear();
      this.detachInnerDockview(workspace);
      this.workspaces.delete(workspaceId);
    }

    if (this.outerApi && this.outerApi.panels.length === 0 && !this.reseedingDefault) {
      this.reseedingDefault = true;
      try {
        await this.initializeDefaultWorkspaceSet();
      } finally {
        this.reseedingDefault = false;
      }
    }

    this.updateDocumentTitle();
    this.scheduleSessionSave();
  }

  private async resetWorkspace(workspace: WorkspaceRecord) {
    if (!workspace.innerApi) {
      return;
    }

    await this.withSessionPersistenceSuppressed(async () => {
      await this.disposeWorkspacePanes(workspace);
      workspace.title = workspace.defaultTitle;
      workspace.outerPanelApi?.setTitle(workspace.defaultTitle);

      const cowsay = this.addPane(workspace, { kind: "cowsay", title: "Cowsay" });
      this.addPane(workspace, {
        kind: "browser",
        title: "Start",
        url: workspace.defaultBrowserPath,
        place: "right",
        referencePaneId: cowsay.id
      });

      workspace.innerApi?.getPanel(cowsay.id)?.group.api.setSize({ width: 440 });
    });
    if (workspace.id === this.getActiveWorkspaceId()) {
      this.updateDocumentTitle();
    }
    this.scheduleSessionSave();
  }

  private addPane(workspace: WorkspaceRecord, input: NewPaneInput): ShellPaneRecordSnapshot {
    if (!workspace.innerApi) {
      throw new Error(`Workspace '${workspace.id}' inner dockview is not ready`);
    }

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

    const panel = workspace.innerApi.addPanel({
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
    return this.mustGetPaneSnapshot(workspace, paneId);
  }

  private resolvePanePosition(workspace: WorkspaceRecord, input: NewPaneInput) {
    const innerApi = workspace.innerApi!;
    const referencePanel =
      (input.referencePaneId && innerApi.getPanel(input.referencePaneId)) ?? innerApi.activePanel;
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
    const activeId = this.getActiveWorkspaceId();
    if (!activeId) {
      throw new Error("No active workspace");
    }
    return this.requireWorkspace(activeId);
  }

  private getActiveWorkspaceId(): string | null {
    return this.outerApi?.activePanel?.id ?? null;
  }

  private toWorkspaceStatus(workspace: WorkspaceRecord) {
    return {
      id: workspace.id,
      title: workspace.title,
      activePaneId: workspace.innerApi?.activePanel?.id ?? null,
      paneCount: workspace.paneRecords.size
    };
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

  private mustGetPaneSnapshot(workspace: WorkspaceRecord, paneId: string): ShellPaneRecordSnapshot {
    const record = this.requirePaneRecord(workspace, paneId);
    const isActive = workspace.innerApi?.activePanel?.id === paneId;
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

  private updateDocumentTitle() {
    const activeId = this.getActiveWorkspaceId();
    const workspace = activeId ? this.workspaces.get(activeId) : null;
    document.title = workspace ? `${this.appTitle} / ${workspace.title}` : this.appTitle;
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
    this.scheduleSessionSave();
  }

  private async restoreSessionOrDefaults() {
    const snapshot = await this.sessionHost.load();
    this.appTitle = snapshot?.appTitle ?? this.appTitle;

    const restoredWorkspaces = Object.entries(snapshot?.workspaces ?? {});
    const workspaceDescriptors = restoredWorkspaces.length > 0
      ? restoredWorkspaces.map(([workspaceId, workspaceSnapshot]) => ({
          id: workspaceId,
          title: workspaceSnapshot.defaultTitle?.trim() || defaultWorkspaceTitle(workspaceId)
        }))
      : [this.allocateWorkspaceDescriptor()];

    this.sessionPersistenceSuppressed = true;
    try {
      for (const descriptor of workspaceDescriptors) {
        const workspace = this.createWorkspaceRecord(descriptor);
        const workspaceSnapshot = snapshot?.workspaces[descriptor.id];
        if (workspaceSnapshot) {
          if (workspaceSnapshot.defaultTitle?.trim()) {
            workspace.defaultTitle = workspaceSnapshot.defaultTitle.trim();
          }
          workspace.title = workspaceSnapshot.title.trim() || workspace.defaultTitle;
          workspace.pendingInnerLayout = (workspaceSnapshot.innerLayout as SerializedDockview | null) ?? null;
        }
        this.mountOuterPanel(workspace);
      }

      const firstDescriptor = workspaceDescriptors[0];
      if (!firstDescriptor) {
        throw new Error("Expected at least one workspace descriptor");
      }
      this.outerApi?.getPanel(firstDescriptor.id)?.focus();

      for (const descriptor of workspaceDescriptors) {
        const workspace = this.requireWorkspace(descriptor.id);
        if (workspace.paneRecords.size === 0) {
          await this.resetWorkspace(workspace);
        }
      }
    } finally {
      this.sessionPersistenceSuppressed = false;
    }
  }

  private async initializeDefaultWorkspaceSet() {
    const workspace = this.createWorkspaceRecord(this.allocateWorkspaceDescriptor());
    this.sessionPersistenceSuppressed = true;
    try {
      this.mountOuterPanel(workspace, { focus: true });
      await this.resetWorkspace(workspace);
    } finally {
      this.sessionPersistenceSuppressed = false;
    }
  }

  private rehydrateWorkspacePaneRecords(workspace: WorkspaceRecord) {
    const innerApi = workspace.innerApi;
    if (!innerApi) {
      return;
    }

    workspace.paneRecords.clear();
    const workspaceContext = this.toPaneWorkspaceContext(workspace);
    for (const panel of innerApi.panels) {
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
      version: 3,
      appTitle: this.appTitle,
      workspaces: Object.fromEntries(
        [...this.workspaces.values()].map((workspace) => [
          workspace.id,
          {
            defaultTitle: workspace.defaultTitle,
            title: workspace.title,
            innerLayout: workspace.innerApi ? this.serializeWorkspaceLayout(workspace) : null
          } satisfies FlmuxWorkspaceSessionSnapshot
        ])
      )
    };
  }

  private serializeWorkspaceLayout(workspace: WorkspaceRecord): SerializedDockview {
    const innerApi = workspace.innerApi!;
    const layout = cloneLayout(innerApi.toJSON());
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

  private async disposeWorkspacePanes(workspace: WorkspaceRecord) {
    const paneIds = [...workspace.paneRecords.keys()];
    for (const paneId of paneIds) {
      await this.closePane(paneId);
    }
  }

  private async withSessionPersistenceSuppressed<T>(callback: () => Promise<T> | T) {
    const previousSuppressed = this.sessionPersistenceSuppressed;
    this.sessionPersistenceSuppressed = true;
    try {
      return await callback();
    } finally {
      this.sessionPersistenceSuppressed = previousSuppressed;
    }
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

  private createWorkspaceRecord(descriptor: WorkspaceDescriptor) {
    const existing = this.workspaces.get(descriptor.id);
    if (existing) {
      return existing;
    }

    const workspace: WorkspaceRecord = {
      id: descriptor.id,
      title: descriptor.title,
      defaultTitle: descriptor.title,
      defaultBrowserPath: defaultBrowserPath(descriptor.id),
      rootDir: joinPath(this.config.projectDir, workspaceRootDirName(descriptor.id)),
      bus: createWorkspaceBus(descriptor.id),
      paneRecords: new Map(),
      outerPanelApi: null,
      innerApi: null,
      innerHost: null,
      innerResizeObserver: null,
      pendingInnerLayout: null
    };
    this.workspaces.set(descriptor.id, workspace);
    return workspace;
  }

  private allocateWorkspaceDescriptor(inputTitle?: string): WorkspaceDescriptor {
    let index = this.workspaces.size + 1;
    while (this.workspaces.has(`workspace.${index}`)) {
      index += 1;
    }

    const title = inputTitle?.trim() || `Workspace ${index}`;
    return {
      id: `workspace.${index}`,
      title
    };
  }
}

class WorkspaceOuterPanelRenderer implements IContentRenderer {
  readonly element: HTMLElement;

  constructor(private readonly workspaceId: string, private readonly workbench: FlmuxWorkbench) {
    this.element = document.createElement("div");
    this.element.className = "workspace-panel";
    this.element.dataset.workspaceId = workspaceId;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    const workspace = this.workbench.getWorkspaceForOuterPanel(this.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace record missing for panel '${this.workspaceId}'`);
    }
    this.workbench.attachInnerDockview(workspace, this.element, parameters.api);
  }

  dispose(): void {
    const workspace = this.workbench.getWorkspaceForOuterPanel(this.workspaceId);
    if (workspace) {
      this.workbench.detachInnerDockview(workspace);
    }
    this.element.replaceChildren();
  }
}

function createPaneId() {
  return `pane_${crypto.randomUUID()}`;
}

function normalizeDirection(place: PanePlacement | undefined) {
  return place ?? "within";
}

function asNonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  return trimmed;
}

function defaultBrowserPath(workspaceId: string) {
  return `/__flmux/internal/start?workspace=${encodeURIComponent(workspaceId)}`;
}

function workspaceRootDirName(workspaceId: string) {
  return workspaceId.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function defaultWorkspaceTitle(workspaceId: string) {
  const numbered = /^workspace\.(\d+)$/.exec(workspaceId);
  if (numbered) {
    return `Workspace ${numbered[1]}`;
  }

  return workspaceId
    .split(/[./_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Workspace";
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
