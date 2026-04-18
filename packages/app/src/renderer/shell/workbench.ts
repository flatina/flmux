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
import {
  PLACEHOLDER_PANE_KIND,
  ShellCore,
  createShellModel,
  type AppStatusSnapshot,
  type NewPaneInput,
  type PaneWorkspaceContext,
  type ScopedPropertyTarget,
  type ShellModelAPI,
  type ShellModelHost,
  type ShellPaneRecordSnapshot,
  type ShellResolvedPanePathMount,
  type ShellResolvedPaneSubtreeMount,
  type WorkspaceBusEvent,
  type WorkspaceStatusSnapshot
} from "@flmux/core/shell";
import {
  PaneRegistry,
  type PaneDescriptor
} from "./paneRegistry";
import { registerBuiltinPaneDescriptors } from "./builtinPaneDescriptors";
import { NewPaneHeaderAction, WorkspaceHeaderActions, humanizePaneKind } from "./headerActions";
import type { FlmuxSessionSnapshot, FlmuxWorkspaceSessionSnapshot } from "../../shared/session";
import type { FlmuxHostRequestProxy, FlmuxRendererBootstrapConfig } from "../../shared/rendererBridge";
import { getFlmuxRendererLifecyclePolicy } from "../../shared/runtimeMode";
import { resolveTerminalCwdFromRoot } from "../../shared/terminalPath";

type WorkspaceRecord = {
  id: string;
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
  private readonly terminalUnsubscribe: () => void;
  private readonly shellCore: ShellCore;
  private readonly paneRegistry = new PaneRegistry();

  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly closingFromCore = new Set<string>();
  private readonly disposingWorkspace = new Set<string>();
  private outerApi: DockviewApi | null = null;

  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;
  private reseedingDefault = false;

  constructor(private readonly config: FlmuxRendererBootstrapConfig, hostProxy: FlmuxHostRequestProxy) {
    this.lifecyclePolicy = getFlmuxRendererLifecyclePolicy(config.mode);
    this.sessionHost = createSessionHost(hostProxy);
    this.terminalHost = createTerminalHost(hostProxy);
    registerBuiltinPaneDescriptors(this.paneRegistry, {
      installRoot: config.projectDir,
      resolveTerminalCwd: resolveTerminalCwdFromRoot
    });
    this.shellCore = new ShellCore({
      paneRegistry: this.paneRegistry,
      runtimeLabel: resolveRuntimeLabel(config.mode),
      projectDir: config.projectDir,
      terminalBackend: this.terminalHost,
      initialAppOrigin: config.appOrigin
    });
    this.terminalUnsubscribe = this.terminalHost.subscribe((event) => {
      this.shellCore.applyTerminalEvent(event);
      this.scheduleSessionSave();
    });
    this.shellModel = createShellModel({
      host: this,
      terminal: this.shellCore.createTerminalDelegate()
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
    this.initializeOuterShell();

    if (this.lifecyclePolicy.restoreSession) {
      await this.restoreSessionOrDefaults();
    } else {
      await this.initializeDefaultWorkspaceSet();
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

  // ── ShellModelHost implementation (all state reads/writes go through shellCore) ──

  async getAppStatus(): Promise<AppStatusSnapshot> {
    return this.shellCore.getAppStatus();
  }

  async listWorkspaces(): Promise<WorkspaceStatusSnapshot[]> {
    return this.shellCore.listWorkspaces();
  }

  async createWorkspace(input: { title?: string } = {}): Promise<WorkspaceStatusSnapshot> {
    const status = await this.shellCore.createWorkspace(input);
    const record = this.createWorkspaceRecord(status.id);
    this.mountOuterPanel(record, { focus: true });
    this.mountWorkspacePanes(record);
    this.scheduleSessionSave();
    return status;
  }

  async resetWorkspace(workspaceId: string): Promise<WorkspaceStatusSnapshot> {
    const record = this.requireWorkspace(workspaceId);
    if (!record.innerApi) {
      throw new Error(`Workspace '${workspaceId}' inner dockview is not ready`);
    }

    // Guard the inner-remove handler so its per-panel shellCore.closePane fire
    // doesn't double up with shellCore.resetWorkspace's own internal close loop.
    // Suppress session save across the whole teardown/reseed so we don't
    // persist an intermediate empty state.
    this.disposingWorkspace.add(workspaceId);
    this.sessionPersistenceSuppressed = true;
    let status: WorkspaceStatusSnapshot;
    try {
      const panelIds = record.innerApi.panels.map((panel) => panel.id);
      for (const id of panelIds) {
        record.innerApi.getPanel(id)?.api.close();
      }

      status = await this.shellCore.resetWorkspace(workspaceId);
      record.outerPanelApi?.setTitle(status.title);
      this.mountWorkspacePanes(record);
    } finally {
      this.disposingWorkspace.delete(workspaceId);
      this.sessionPersistenceSuppressed = false;
    }

    if (workspaceId === this.shellCore.getActiveWorkspaceId()) {
      this.updateDocumentTitle();
    }
    this.scheduleSessionSave();
    return status;
  }

  async getWorkspaceStatus(): Promise<WorkspaceStatusSnapshot> {
    return this.shellCore.getWorkspaceStatus();
  }

  async setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown) {
    const result = await this.shellCore.setScopedProperty(target, key, value);
    if (key === "title") {
      const title = String(result.value);
      switch (target.scope) {
        case "app":
          this.updateDocumentTitle();
          break;
        case "workspace": {
          const wsId = target.workspaceId ?? this.shellCore.getActiveWorkspaceId();
          if (wsId) {
            this.workspaces.get(wsId)?.outerPanelApi?.setTitle(title);
            if (wsId === this.shellCore.getActiveWorkspaceId()) {
              this.updateDocumentTitle();
            }
          }
          break;
        }
        case "pane": {
          const wsId = this.shellCore.getPaneWorkspaceId(target.paneId);
          const record = wsId ? this.workspaces.get(wsId) : null;
          record?.innerApi?.getPanel(target.paneId)?.api.setTitle(title);
          break;
        }
      }
    }
    this.scheduleSessionSave();
    return result;
  }

  async hasPaneKind(kind: string): Promise<boolean> {
    return this.shellCore.hasPaneKind(kind);
  }

  async listPanes(): Promise<ShellPaneRecordSnapshot[]> {
    return this.shellCore.listPanes();
  }

  async getPane(paneId: string): Promise<ShellPaneRecordSnapshot | undefined> {
    return this.shellCore.getPane(paneId);
  }

  async createPane(input: NewPaneInput): Promise<ShellPaneRecordSnapshot> {
    const snapshot = await this.shellCore.createPane(input);
    const wsId = this.shellCore.getPaneWorkspaceId(snapshot.id);
    if (!wsId) {
      throw new Error(`Created pane '${snapshot.id}' has no workspace`);
    }
    const record = this.requireWorkspace(wsId);
    if (!record.innerApi) {
      throw new Error(`Workspace '${wsId}' inner dockview is not ready`);
    }
    record.innerApi.addPanel({
      id: snapshot.id,
      component: snapshot.kind,
      title: snapshot.title,
      params: this.shellCore.peekPaneParams(snapshot.id),
      position: this.resolvePanePosition(record, input)
    });
    this.scheduleSessionSave();
    return snapshot;
  }

  async closePane(paneId: string): Promise<{ paneId: string; closed: boolean }> {
    if (this.closingFromCore.has(paneId)) {
      return { paneId, closed: false };
    }
    this.closingFromCore.add(paneId);
    try {
      const result = await this.shellCore.closePane(paneId);
      const panel = this.findPanelByPaneId(paneId);
      panel?.api.close();
      this.scheduleSessionSave();
      return result;
    } finally {
      this.closingFromCore.delete(paneId);
    }
  }

  async getPaneParams(paneId: string) {
    return this.shellCore.getPaneParams(paneId);
  }

  async setPaneParams(paneId: string, nextParams: Record<string, unknown>) {
    const result = await this.shellCore.setPaneParams(paneId, nextParams);
    this.notifyPanelParamsChanged(paneId);
    this.scheduleSessionSave();
    return result;
  }

  async patchPaneParams(paneId: string, patch: Record<string, unknown>) {
    const result = await this.shellCore.patchPaneParams(paneId, patch);
    this.notifyPanelParamsChanged(paneId);
    this.scheduleSessionSave();
    return result;
  }

  /**
   * Core is the authority for params. This just fans the new value onto
   * dockview's panel.update() so renderers that listen to PanelUpdateEvent
   * (extension panes, browser pane url mirror) see the change. Save continues
   * to read from core, not dockview.
   */
  private notifyPanelParamsChanged(paneId: string) {
    const panel = this.findPanelByPaneId(paneId);
    if (!panel) {
      return;
    }
    const params = this.shellCore.peekPaneParams(paneId);
    panel.api.updateParameters(params ?? {});
  }

  async getPaneSubtreeMounts(paneId: string): Promise<ShellResolvedPaneSubtreeMount[]> {
    const mounts = await this.shellCore.getPaneSubtreeMounts(paneId);
    return mounts.map((mount) => this.wrapPaneMount(paneId, mount));
  }

  async getPanePathMount(paneId: string): Promise<ShellResolvedPanePathMount | undefined> {
    const mount = await this.shellCore.getPanePathMount(paneId);
    return mount ? this.wrapPaneMount(paneId, mount) : undefined;
  }

  /**
   * Mount setState routes update through shellCore (core-authoritative); the wrapper
   * additionally fires panel.updateParameters so dockview-based renderers (browser,
   * extension panes) receive the PanelUpdateEvent they rely on for re-rendering.
   */
  private wrapPaneMount(paneId: string, mount: ShellResolvedPanePathMount): ShellResolvedPanePathMount {
    if (!mount.setState) {
      return mount;
    }
    const setState = mount.setState;
    return {
      ...mount,
      setState: async (relativePath, value) => {
        const result = await setState(relativePath, value);
        this.notifyPanelParamsChanged(paneId);
        this.scheduleSessionSave();
        return result;
      }
    };
  }

  async publishWorkspaceEvent(input: { topic: string; sourcePaneId: string; payload: unknown }): Promise<WorkspaceBusEvent> {
    return this.shellCore.publishWorkspaceEvent(input);
  }

  // ── Outer-panel renderer helpers (called by WorkspaceOuterPanelRenderer) ──

  attachInnerDockview(record: WorkspaceRecord, host: HTMLElement, outerApi: DockviewPanelApi) {
    record.outerPanelApi = outerApi;
    record.innerHost = host;

    const innerApi = createDockview(host, {
      theme: themeAbyss,
      disableFloatingGroups: true,
      createComponent: (options) => this.createInnerPanelRenderer(record, options),
      createRightHeaderActionComponent: (group) => new NewPaneHeaderAction(group, {
        listKinds: () => this.paneRegistry.list().map((descriptor) => ({
          kind: descriptor.kind,
          label: humanizePaneKind(descriptor.kind)
        })),
        onSelect: (kind) => {
          void this.shellModel.pathCall("/panes/new", { kind, place: "right" });
        }
      })
    });
    record.innerApi = innerApi;

    this.bindInnerDockviewEvents(record);

    if (record.pendingInnerLayout) {
      try {
        innerApi.fromJSON(record.pendingInnerLayout);
      } catch (error) {
        console.warn(`failed to restore workspace '${record.id}' inner layout`, error);
        this.disposingWorkspace.add(record.id);
        try {
          innerApi.clear();
        } catch {}
        this.reseedWorkspaceAfterInnerFailure(record).catch((err) => {
          console.warn(`inner-layout fallback reseed failed for '${record.id}'`, err);
        }).finally(() => {
          this.disposingWorkspace.delete(record.id);
        });
      }
      record.pendingInnerLayout = null;
    }

    const layoutInner = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (record.innerApi && width > 0 && height > 0) {
        record.innerApi.layout(width, height, true);
      }
    };

    record.innerResizeObserver = new ResizeObserver(() => layoutInner());
    record.innerResizeObserver.observe(host);
    requestAnimationFrame(layoutInner);
  }

  detachInnerDockview(record: WorkspaceRecord) {
    record.innerResizeObserver?.disconnect();
    record.innerResizeObserver = null;
    record.innerApi?.dispose();
    record.innerApi = null;
    record.innerHost = null;
    record.outerPanelApi = null;
  }

  getWorkspaceForOuterPanel(panelId: string): WorkspaceRecord | null {
    return this.workspaces.get(panelId) ?? null;
  }

  // ── Internal helpers ──

  private requirePaneDescriptor(kind: string) {
    const descriptor = this.paneRegistry.get(kind);
    if (!descriptor) {
      throw new Error(`Unknown panel component '${kind}'`);
    }
    return descriptor;
  }

  private toWorkspaceContext(workspaceId: string): PaneWorkspaceContext {
    const context = this.shellCore.getWorkspaceContext(workspaceId);
    if (!context) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    return context;
  }

  private initializeOuterShell() {
    this.shellEl.replaceChildren();
    this.workspaces.clear();

    this.outerApi = createDockview(this.shellEl, {
      theme: themeAbyss,
      disableFloatingGroups: true,
      defaultRenderer: "always",
      createComponent: (options) => this.createOuterPanelRenderer(options),
      createRightHeaderActionComponent: (group) => new WorkspaceHeaderActions(group, {
        onAdd: () => {
          void this.shellModel.pathCall("/workspaces/new");
        },
        onResetActive: () => {
          const activeId = this.shellCore.getActiveWorkspaceId();
          if (!activeId) {
            return;
          }
          void this.shellModel.pathCall(`/workspaces/${activeId}/reset`);
        }
      })
    });

    this.outerApi.onDidActivePanelChange((panel) => {
      this.shellCore.setActiveWorkspace(panel?.id ?? null);
      this.updateDocumentTitle();
      this.scheduleSessionSave();
    });
    this.outerApi.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
    this.outerApi.onDidRemovePanel((panel) => {
      void this.handleOuterPanelRemoved(panel.id);
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

  // The guard lives set across the await microtask boundary, during which
  // dockview synchronously runs WorkspaceOuterPanelRenderer.dispose → innerApi.dispose
  // and fans out per-pane onDidRemovePanel. Inner handler sees the guard and skips
  // shellCore.closePane (core records are already dropped by deleteWorkspace).
  private async handleOuterPanelRemoved(workspaceId: string) {
    this.disposingWorkspace.add(workspaceId);
    try {
      await this.shellCore.deleteWorkspace(workspaceId);
      this.workspaces.delete(workspaceId);
      this.updateDocumentTitle();
      this.scheduleSessionSave();
      if (this.outerApi && this.outerApi.panels.length === 0 && !this.reseedingDefault) {
        this.reseedingDefault = true;
        try {
          await this.initializeDefaultWorkspaceSet();
        } finally {
          this.reseedingDefault = false;
        }
      }
    } finally {
      this.disposingWorkspace.delete(workspaceId);
    }
  }

  private createOuterPanelRenderer(options: CreateComponentOptions): IContentRenderer {
    if (String(options.name) !== OUTER_WORKSPACE_COMPONENT) {
      throw new Error(`Unknown outer component '${options.name}'`);
    }
    return new WorkspaceOuterPanelRenderer(options.id, this);
  }

  private createInnerPanelRenderer(record: WorkspaceRecord, options: CreateComponentOptions): IContentRenderer {
    const descriptor = this.requirePaneDescriptor(String(options.name));
    return descriptor.createRenderer({
      workspace: this.toWorkspaceContext(record.id),
      options,
      runtime: {
        shellModel: this.shellModel,
        browserPanelTemplate: this.browserPanelTemplate,
        terminalHost: this.terminalHost,
        normalizeBrowserUrl: (value) => this.normalizeBrowserUrlFromInput(value),
        onBrowserUrlChange: (paneId, url) => {
          void this.shellModel.pathSet(`/panes/${paneId}/browser/url`, url).catch((error) => {
            console.warn(`failed to propagate browser url change for pane '${paneId}'`, error);
          });
        }
      }
    });
  }

  private bindInnerDockviewEvents(record: WorkspaceRecord) {
    const api = record.innerApi!;

    api.onDidActivePanelChange((panel) => {
      this.shellCore.setActivePane(record.id, panel?.id ?? null);
      this.scheduleSessionSave();
    });
    api.onDidAddPanel(() => {
      this.scheduleSessionSave();
    });
    api.onDidRemovePanel((panel) => {
      if (this.closingFromCore.has(panel.id)) {
        return;
      }
      if (this.disposingWorkspace.has(record.id)) {
        return;
      }
      void this.shellCore.closePane(panel.id).catch((error) => {
        console.warn(`failed to close pane '${panel.id}' in shellCore`, error);
      });
      this.scheduleSessionSave();
    });
    api.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
  }

  private mountOuterPanel(record: WorkspaceRecord, options: { focus?: boolean } = {}) {
    if (!this.outerApi) {
      throw new Error("Outer dockview is not initialized");
    }
    if (this.outerApi.getPanel(record.id)) {
      return;
    }

    const status = this.shellCore.getWorkspaceSnapshot(record.id);
    const panel = this.outerApi.addPanel({
      id: record.id,
      component: OUTER_WORKSPACE_COMPONENT,
      title: status?.title ?? record.id
    });
    if (options.focus) {
      panel.focus();
    }
  }

  private mountWorkspacePanes(record: WorkspaceRecord) {
    if (!record.innerApi) {
      throw new Error(`Workspace '${record.id}' inner dockview is not ready`);
    }
    const panes = this.shellCore.listPanesByWorkspace(record.id);
    let firstPaneId: string | null = null;
    for (const pane of panes) {
      record.innerApi.addPanel({
        id: pane.id,
        component: pane.kind,
        title: pane.title,
        params: this.shellCore.peekPaneParams(pane.id),
        position: firstPaneId
          ? {
              referencePanel: record.innerApi.getPanel(firstPaneId)!,
              direction: "right"
            }
          : undefined
      });
      if (firstPaneId === null) {
        firstPaneId = pane.id;
      }
    }
    if (firstPaneId && panes[0]?.kind === "cowsay") {
      record.innerApi.getPanel(firstPaneId)?.group.api.setSize({ width: 440 });
    }
  }

  private resolvePanePosition(record: WorkspaceRecord, input: NewPaneInput) {
    const innerApi = record.innerApi!;
    const referencePanel =
      (input.referencePaneId && innerApi.getPanel(input.referencePaneId)) ?? innerApi.activePanel;
    const direction = input.place ?? "within";
    if (!referencePanel) {
      return undefined;
    }
    return { referencePanel, direction };
  }

  private findPanelByPaneId(paneId: string) {
    for (const record of this.workspaces.values()) {
      const panel = record.innerApi?.getPanel(paneId);
      if (panel) {
        return panel;
      }
    }
    return null;
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const record = this.workspaces.get(workspaceId);
    if (!record) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    return record;
  }

  private updateDocumentTitle() {
    const activeId = this.shellCore.getActiveWorkspaceId();
    const status = activeId ? this.shellCore.getWorkspaceSnapshot(activeId) : undefined;
    const appTitle = this.shellCore.getAppTitle();
    document.title = status ? `${appTitle} / ${status.title}` : appTitle;
  }

  private async restoreSessionOrDefaults() {
    const snapshot = await this.sessionHost.load();
    if (snapshot?.appTitle) {
      this.shellCore.setAppTitle(snapshot.appTitle);
    }

    const restoredWorkspaces = Object.entries(snapshot?.workspaces ?? {});
    if (restoredWorkspaces.length === 0 || !snapshot?.outerLayout) {
      await this.initializeDefaultWorkspaceSet();
      return;
    }

    this.sessionPersistenceSuppressed = true;
    try {
      const outerPanelIds = extractOuterPanelIds(snapshot.outerLayout);
      for (const [workspaceId, workspaceSnapshot] of restoredWorkspaces) {
        // Drop workspaces that the outer layout doesn't reference — they'd
        // become invisible core-only records.
        if (!outerPanelIds.has(workspaceId)) {
          continue;
        }
        const defaultTitle = workspaceSnapshot.defaultTitle?.trim() || defaultWorkspaceTitle(workspaceId);
        const title = workspaceSnapshot.title.trim() || defaultTitle;
        this.shellCore.restoreWorkspace({ id: workspaceId, title, defaultTitle });

        const record = this.createWorkspaceRecord(workspaceId);
        const innerLayout = workspaceSnapshot.innerLayout as SerializedDockview | null;
        record.pendingInnerLayout = innerLayout
          ? this.rebuildPaneRecordsFromLayout(workspaceId, innerLayout)
          : null;
      }

      try {
        this.outerApi!.fromJSON(snapshot.outerLayout as SerializedDockview);
        if (this.outerApi!.panels.length === 0) {
          throw new Error("outer layout restored zero panels");
        }
      } catch (error) {
        console.warn("failed to restore outer workspace layout; falling back to defaults", error);
        await this.fallbackToDefaultWorkspaceSet();
      }
    } finally {
      this.sessionPersistenceSuppressed = false;
    }
  }

  /**
   * Outer-layout restore failed. Wipe core + view atomically and re-seed a
   * fresh default workspace. `reseedingDefault` is set for the whole span so
   * the per-panel `onDidRemovePanel` handler that fires during outerApi.clear()
   * doesn't race with our explicit initializeDefaultWorkspaceSet().
   */
  private async fallbackToDefaultWorkspaceSet() {
    this.reseedingDefault = true;
    try {
      await this.shellCore.clearAll();
      this.outerApi!.clear();
      this.workspaces.clear();
      await this.initializeDefaultWorkspaceSet();
    } finally {
      this.reseedingDefault = false;
    }
  }

  /**
   * Parse the persisted inner layout JSON and restore each pane into shellCore,
   * rewriting the JSON's contentComponent to "placeholder" for panes that core
   * substituted (unknown kind, normalize/create hook throw). Also overlays the
   * normalized params from core back onto the layout JSON so innerApi.fromJSON
   * hands each pane renderer the same params core holds (e.g. browser URLs
   * get the current app-origin prefix restored, not the stripped save form).
   */
  private rebuildPaneRecordsFromLayout(workspaceId: string, layout: SerializedDockview): SerializedDockview {
    const next = cloneLayout(layout);
    for (const [paneId, panelState] of Object.entries(next.panels ?? {})) {
      const kind = typeof panelState.contentComponent === "string" ? panelState.contentComponent : "";
      if (!kind) {
        throw new Error(`Persisted panel '${paneId}' missing contentComponent`);
      }
      const params = cloneJsonObject(panelState.params);
      const title = typeof panelState.title === "string" ? panelState.title : undefined;
      const snapshot = this.shellCore.restorePane(workspaceId, {
        paneId,
        kind,
        params,
        title
      });
      const normalizedParams = this.shellCore.peekPaneParams(paneId);
      if (snapshot.kind !== kind) {
        panelState.contentComponent = PLACEHOLDER_PANE_KIND;
        panelState.title = snapshot.title;
        panelState.params = normalizedParams ?? { originalKind: kind };
      } else if (normalizedParams !== undefined) {
        panelState.params = normalizedParams;
      }
    }
    return next;
  }

  private async initializeDefaultWorkspaceSet() {
    const status = await this.shellCore.createWorkspace();
    const record = this.createWorkspaceRecord(status.id);
    this.sessionPersistenceSuppressed = true;
    try {
      this.mountOuterPanel(record, { focus: true });
      this.mountWorkspacePanes(record);
    } finally {
      this.sessionPersistenceSuppressed = false;
    }
  }

  private async reseedWorkspaceAfterInnerFailure(record: WorkspaceRecord) {
    // Inner fromJSON threw. Drop the core records for this workspace, re-seed
    // fresh defaults (same id), and mount them. Outer layout is preserved.
    await this.shellCore.deleteWorkspace(record.id);
    const title = defaultWorkspaceTitle(record.id);
    this.shellCore.restoreWorkspace({ id: record.id, title, defaultTitle: title });
    const status = await this.shellCore.resetWorkspace(record.id);
    record.outerPanelApi?.setTitle(status.title);
    this.mountWorkspacePanes(record);
  }

  private serializeSessionSnapshot(): FlmuxSessionSnapshot {
    return {
      version: 4,
      appTitle: this.shellCore.getAppTitle(),
      outerLayout: this.outerApi?.toJSON() ?? null,
      workspaces: Object.fromEntries(
        this.shellCore.getWorkspaceIds().map((workspaceId) => {
          const status = this.shellCore.getWorkspaceSnapshot(workspaceId)!;
          const record = this.workspaces.get(workspaceId);
          const innerLayout = record?.innerApi ? this.serializeWorkspaceLayout(workspaceId, record) : null;
          return [
            workspaceId,
            {
              defaultTitle: status.defaultTitle,
              title: status.title,
              innerLayout
            } satisfies FlmuxWorkspaceSessionSnapshot
          ];
        })
      )
    };
  }

  private serializeWorkspaceLayout(workspaceId: string, record: WorkspaceRecord): SerializedDockview {
    const innerApi = record.innerApi!;
    const layout = cloneLayout(innerApi.toJSON());
    for (const [panelId, panelState] of Object.entries(layout.panels ?? {})) {
      if (this.shellCore.getPaneWorkspaceId(panelId) !== workspaceId) {
        continue;
      }
      const params = this.shellCore.serializePaneParams(panelId);
      if (params !== undefined) {
        panelState.params = params;
      }
    }
    return layout;
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

  private normalizeBrowserUrlFromInput(value: string): string | null {
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

  private createWorkspaceRecord(workspaceId: string): WorkspaceRecord {
    const existing = this.workspaces.get(workspaceId);
    if (existing) {
      return existing;
    }

    const record: WorkspaceRecord = {
      id: workspaceId,
      outerPanelApi: null,
      innerApi: null,
      innerHost: null,
      innerResizeObserver: null,
      pendingInnerLayout: null
    };
    this.workspaces.set(workspaceId, record);
    return record;
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
    const record = this.workbench.getWorkspaceForOuterPanel(this.workspaceId);
    if (!record) {
      throw new Error(`Workspace record missing for panel '${this.workspaceId}'`);
    }
    this.workbench.attachInnerDockview(record, this.element, parameters.api);
  }

  dispose(): void {
    const record = this.workbench.getWorkspaceForOuterPanel(this.workspaceId);
    if (record) {
      this.workbench.detachInnerDockview(record);
    }
    this.element.replaceChildren();
  }
}

function resolveRuntimeLabel(mode: string) {
  return mode === "desktop" ? "desktop local-http preload ok" : "web local-http attach";
}

function extractOuterPanelIds(outerLayout: unknown): Set<string> {
  const ids = new Set<string>();
  if (!outerLayout || typeof outerLayout !== "object") {
    return ids;
  }
  const panels = (outerLayout as { panels?: Record<string, unknown> }).panels;
  if (panels && typeof panels === "object") {
    for (const id of Object.keys(panels)) {
      ids.add(id);
    }
  }
  return ids;
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

function cloneJsonObject(value: unknown) {
  return value && typeof value === "object"
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : undefined;
}

function cloneLayout<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
