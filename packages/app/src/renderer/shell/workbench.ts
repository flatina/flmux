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
import { createTerminalHost } from "../terminalHost";
import {
  type NewPaneInput,
  type PaneWorkspaceContext,
  type SequencedShellCoreEvent,
  type ShellModelAPI,
  type ShellPaneRecordSnapshot
} from "@flmux/core/shell";
import {
  PaneRegistry,
  type PaneDescriptor
} from "./paneRegistry";
import { registerBuiltinPaneDescriptors } from "./builtinPaneDescriptors";
import { NewPaneHeaderAction, WorkspaceHeaderActions, humanizePaneKind } from "./headerActions";
import type {
  FlmuxHostRequestProxy,
  FlmuxRendererBootstrapConfig,
  FlmuxSessionSaveLayouts,
  FlmuxShellBootstrapResponse
} from "../../shared/rendererBridge";
import { getFlmuxRendererLifecyclePolicy } from "../../shared/runtimeMode";
import { resolveTerminalCwdFromRoot } from "../../shared/terminalPath";
import { createShellModelClientOverPreload } from "./shellModelClient";
import { subscribeShellCoreEvents } from "./shellEventBus";

type PendingPane = {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown> | undefined;
};

type WorkspaceRecord = {
  id: string;
  outerPanelApi: DockviewPanelApi | null;
  innerApi: DockviewApi | null;
  innerHost: HTMLElement | null;
  innerResizeObserver: ResizeObserver | null;
  pendingInnerLayout: SerializedDockview | null;
  pendingPanes: PendingPane[] | null;
};

const OUTER_WORKSPACE_COMPONENT = "workspace";

export class FlmuxWorkbench {
  readonly shellModel: ShellModelAPI;
  private readonly lifecyclePolicy: ReturnType<typeof getFlmuxRendererLifecyclePolicy>;

  private readonly shellEl = document.querySelector<HTMLElement>(".dockview-shell")!;
  private readonly browserPanelTemplate = document.getElementById("browser-panel-tpl") as HTMLTemplateElement;
  private readonly terminalHost: ReturnType<typeof createTerminalHost>;
  private readonly paneRegistry = new PaneRegistry();

  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly closingFromCore = new Set<string>();
  private readonly disposingWorkspace = new Set<string>();
  private outerApi: DockviewApi | null = null;

  // Bootstrap + seq gate
  private bootstrapped = false;
  private lastAppliedSeq = 0;
  private eventBuffer: SequencedShellCoreEvent[] = [];
  private unsubscribeCoreEvents: (() => void) | null = null;

  // Mirrored app-level state (needed to render document title; core is authoritative)
  private appTitle = "flmux";
  private activeWorkspaceId: string | null = null;

  // Suppresses dockview→pathCall while we are applying core-driven state to dockview
  private applyingCoreState = false;

  // Save throttling
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;

  constructor(
    private readonly config: FlmuxRendererBootstrapConfig,
    private readonly hostProxy: FlmuxHostRequestProxy
  ) {
    this.lifecyclePolicy = getFlmuxRendererLifecyclePolicy(config.mode);
    this.terminalHost = createTerminalHost(hostProxy);
    registerBuiltinPaneDescriptors(this.paneRegistry, {
      installRoot: config.projectDir,
      resolveTerminalCwd: resolveTerminalCwdFromRoot
    });
    this.shellModel = createShellModelClientOverPreload(hostProxy);
    this.unsubscribeCoreEvents = subscribeShellCoreEvents((event) => this.handleCoreEvent(event));
  }

  registerExternalPane(descriptor: PaneDescriptor) {
    this.paneRegistry.register(descriptor);
  }

  async start() {
    this.initializeOuterShell();

    const bootstrap = await this.hostProxy["flmux.shellBootstrap"]();
    this.applyBootstrap(bootstrap);
    this.lastAppliedSeq = bootstrap.seqStart;
    this.bootstrapped = true;
    this.drainBufferedEvents();

    this.updateDocumentTitle();
    setupDropIndicatorMasks();

    if (this.lifecyclePolicy.persistSession) {
      this.sessionPersistenceEnabled = true;
      window.addEventListener("pagehide", () => {
        void this.flushSessionSave({ preferBeacon: true });
      });
    }
  }

  // ── Bootstrap ──

  private applyBootstrap(bootstrap: FlmuxShellBootstrapResponse) {
    const priorApplying = this.applyingCoreState;
    this.applyingCoreState = true;
    this.sessionPersistenceSuppressed = true;
    try {
      this.appTitle = bootstrap.snapshot.app.title;
      this.activeWorkspaceId = bootstrap.snapshot.activeWorkspaceId;

      for (const workspace of bootstrap.snapshot.workspaces) {
        const record = this.createWorkspaceRecord(workspace.id);
        const innerLayout = bootstrap.innerLayouts[workspace.id] as SerializedDockview | null | undefined;
        if (innerLayout) {
          record.pendingInnerLayout = innerLayout;
        } else {
          record.pendingPanes = (bootstrap.snapshot.panes[workspace.id] ?? []).map((pane) => ({
            id: pane.id,
            kind: pane.kind,
            title: pane.title,
            params: bootstrap.snapshot.paneParams[pane.id]
          }));
        }
      }

      if (bootstrap.outerLayout) {
        try {
          this.outerApi!.fromJSON(bootstrap.outerLayout as SerializedDockview);
        } catch (error) {
          console.warn("failed to restore outer workspace layout; falling back to addPanel loop", error);
          this.rebuildOuterFromSnapshot(bootstrap);
        }
      } else {
        this.rebuildOuterFromSnapshot(bootstrap);
      }

      if (this.activeWorkspaceId) {
        this.outerApi!.getPanel(this.activeWorkspaceId)?.api.setActive();
      }
    } finally {
      this.sessionPersistenceSuppressed = false;
      this.applyingCoreState = priorApplying;
    }
  }

  private rebuildOuterFromSnapshot(bootstrap: FlmuxShellBootstrapResponse) {
    this.outerApi!.clear();
    for (const workspace of bootstrap.snapshot.workspaces) {
      this.outerApi!.addPanel({
        id: workspace.id,
        component: OUTER_WORKSPACE_COMPONENT,
        title: workspace.title
      });
    }
  }

  // ── Core event handling ──

  private handleCoreEvent(event: SequencedShellCoreEvent) {
    if (!this.bootstrapped) {
      this.eventBuffer.push(event);
      return;
    }
    if (event.seq <= this.lastAppliedSeq) {
      return;
    }
    this.applyEvent(event);
    this.lastAppliedSeq = event.seq;
  }

  private drainBufferedEvents() {
    const pending = this.eventBuffer;
    this.eventBuffer = [];
    for (const event of pending) {
      if (event.seq <= this.lastAppliedSeq) {
        continue;
      }
      this.applyEvent(event);
      this.lastAppliedSeq = event.seq;
    }
  }

  private applyEvent(event: SequencedShellCoreEvent) {
    const priorApplying = this.applyingCoreState;
    this.applyingCoreState = true;
    try {
      switch (event.topic) {
        case "app.titleChanged":
          this.appTitle = event.payload.title;
          this.updateDocumentTitle();
          break;
        case "workspace.added":
          this.applyWorkspaceAdded(event.payload);
          break;
        case "workspace.removed":
          this.applyWorkspaceRemoved(event.payload);
          break;
        case "workspace.titleChanged":
          this.applyWorkspaceTitleChanged(event.payload);
          break;
        case "workspace.activeChanged":
          this.applyWorkspaceActiveChanged(event.payload);
          break;
        case "pane.added":
          this.applyPaneAdded(event.payload);
          break;
        case "pane.removed":
          this.applyPaneRemoved(event.payload);
          break;
        case "pane.titleChanged":
          this.applyPaneTitleChanged(event.payload);
          break;
        case "pane.paramsChanged":
          this.applyPaneParamsChanged(event.payload);
          break;
        case "pane.activeChanged":
          this.applyPaneActiveChanged(event.payload);
          break;
      }
    } finally {
      this.applyingCoreState = priorApplying;
    }
    this.scheduleSessionSave();
  }

  private applyWorkspaceAdded(payload: {
    id: string;
    title: string;
    defaultTitle: string;
  }) {
    if (this.workspaces.has(payload.id)) {
      return;
    }
    this.createWorkspaceRecord(payload.id);
    if (!this.outerApi?.getPanel(payload.id)) {
      this.outerApi?.addPanel({
        id: payload.id,
        component: OUTER_WORKSPACE_COMPONENT,
        title: payload.title
      });
    }
  }

  private applyWorkspaceRemoved(payload: { id: string; newActiveWorkspaceId: string | null }) {
    const panel = this.outerApi?.getPanel(payload.id);
    if (panel) {
      this.disposingWorkspace.add(payload.id);
      try {
        panel.api.close();
      } finally {
        this.disposingWorkspace.delete(payload.id);
      }
    }
    this.workspaces.delete(payload.id);
    if (payload.newActiveWorkspaceId) {
      this.outerApi?.getPanel(payload.newActiveWorkspaceId)?.api.setActive();
    }
  }

  private applyWorkspaceTitleChanged(payload: { id: string; title: string }) {
    this.outerApi?.getPanel(payload.id)?.api.setTitle(payload.title);
    if (payload.id === this.activeWorkspaceId) {
      this.updateDocumentTitle();
    }
  }

  private applyWorkspaceActiveChanged(payload: { id: string | null }) {
    this.activeWorkspaceId = payload.id;
    if (payload.id) {
      this.outerApi?.getPanel(payload.id)?.api.setActive();
    }
    this.updateDocumentTitle();
  }

  private applyPaneAdded(payload: {
    paneId: string;
    workspaceId: string;
    snapshot: ShellPaneRecordSnapshot;
    params: Record<string, unknown> | undefined;
    place?: "within" | "left" | "right" | "above" | "below";
    referencePaneId?: string;
  }) {
    const record = this.workspaces.get(payload.workspaceId);
    // innerApi is attached synchronously during WorkspaceOuterPanelRenderer.init;
    // if it is missing here, the outer panel for this workspace hasn't been
    // materialized yet — drop silently (pane re-materializes on later mount).
    if (!record || !record.innerApi) {
      return;
    }
    if (record.innerApi.getPanel(payload.paneId)) {
      return;
    }
    const referencePanel =
      (payload.referencePaneId && record.innerApi.getPanel(payload.referencePaneId)) ?? record.innerApi.activePanel;
    const position = referencePanel && payload.place
      ? { referencePanel, direction: payload.place }
      : undefined;
    record.innerApi.addPanel({
      id: payload.paneId,
      component: payload.snapshot.kind,
      title: payload.snapshot.title,
      params: payload.params,
      position
    });
  }

  private applyPaneRemoved(payload: {
    paneId: string;
    workspaceId: string;
    newActivePaneId: string | null;
  }) {
    const record = this.workspaces.get(payload.workspaceId);
    const panel = record?.innerApi?.getPanel(payload.paneId);
    if (panel) {
      this.closingFromCore.add(payload.paneId);
      try {
        panel.api.close();
      } finally {
        this.closingFromCore.delete(payload.paneId);
      }
    }
    if (payload.newActivePaneId) {
      record?.innerApi?.getPanel(payload.newActivePaneId)?.api.setActive();
    }
  }

  private applyPaneTitleChanged(payload: { paneId: string; workspaceId: string; title: string }) {
    const record = this.workspaces.get(payload.workspaceId);
    record?.innerApi?.getPanel(payload.paneId)?.api.setTitle(payload.title);
  }

  private applyPaneParamsChanged(payload: {
    paneId: string;
    workspaceId: string;
    params: Record<string, unknown> | undefined;
  }) {
    const record = this.workspaces.get(payload.workspaceId);
    record?.innerApi?.getPanel(payload.paneId)?.api.updateParameters(payload.params ?? {});
  }

  private applyPaneActiveChanged(payload: { workspaceId: string; paneId: string | null }) {
    if (!payload.paneId) {
      return;
    }
    const record = this.workspaces.get(payload.workspaceId);
    record?.innerApi?.getPanel(payload.paneId)?.api.setActive();
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
    this.mountPendingInner(record);

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

  private mountPendingInner(record: WorkspaceRecord) {
    if (!record.innerApi) {
      return;
    }
    const priorApplying = this.applyingCoreState;
    this.applyingCoreState = true;
    try {
      if (record.pendingInnerLayout) {
        try {
          record.innerApi.fromJSON(record.pendingInnerLayout);
        } catch (error) {
          console.warn(`failed to restore workspace '${record.id}' inner layout; falling back to reset`, error);
          this.disposingWorkspace.add(record.id);
          try {
            record.innerApi.clear();
            void this.shellModel.pathCall(`/workspaces/${record.id}/reset`).catch((err) => {
              console.warn(`reset fallback failed for '${record.id}'`, err);
            });
          } finally {
            this.disposingWorkspace.delete(record.id);
          }
        }
        record.pendingInnerLayout = null;
      } else if (record.pendingPanes) {
        const innerApi = record.innerApi;
        let firstPanelId: string | null = null;
        for (const pane of record.pendingPanes) {
          innerApi.addPanel({
            id: pane.id,
            component: pane.kind,
            title: pane.title,
            params: pane.params,
            position: firstPanelId
              ? {
                  referencePanel: innerApi.getPanel(firstPanelId)!,
                  direction: "right"
                }
              : undefined
          });
          if (firstPanelId === null) {
            firstPanelId = pane.id;
          }
        }
        if (firstPanelId && record.pendingPanes[0]?.kind === "cowsay") {
          innerApi.getPanel(firstPanelId)?.group.api.setSize({ width: 440 });
        }
        record.pendingPanes = null;
      }
    } finally {
      this.applyingCoreState = priorApplying;
    }
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
    return {
      id: workspaceId,
      defaultBrowserPath: `/__flmux/internal/start?workspace=${encodeURIComponent(workspaceId)}`,
      bus: {
        publish: () => {},
        subscribe: () => () => {}
      },
      appOrigin: this.config.appOrigin
    };
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
          if (!this.activeWorkspaceId) {
            return;
          }
          void this.shellModel.pathCall(`/workspaces/${this.activeWorkspaceId}/reset`);
        }
      })
    });

    this.outerApi.onDidActivePanelChange((panel) => {
      if (this.applyingCoreState) {
        return;
      }
      if (panel) {
        void this.shellModel.pathCall(`/workspaces/${panel.id}/setActive`);
      }
      this.scheduleSessionSave();
    });
    this.outerApi.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
    this.outerApi.onDidRemovePanel((panel) => {
      if (this.applyingCoreState || this.disposingWorkspace.has(panel.id)) {
        return;
      }
      // Hold the guard across the pathCall Promise: dockview's synchronous
      // disposal cascade (WorkspaceOuterPanelRenderer.dispose → innerApi.dispose
      // → per-pane onDidRemovePanel) fires AFTER this callback returns but
      // before the pathCall resolves. Inner handler checks disposingWorkspace
      // to skip re-issuing /panes/{id}/close for panes being torn down by the
      // parent workspace delete.
      this.disposingWorkspace.add(panel.id);
      void this.shellModel
        .pathCall(`/workspaces/${panel.id}/delete`)
        .catch((error) => {
          console.warn(`failed to delete workspace '${panel.id}' via shellModel`, error);
        })
        .finally(() => {
          this.disposingWorkspace.delete(panel.id);
        });
      this.scheduleSessionSave();
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
      if (this.applyingCoreState) {
        return;
      }
      if (panel) {
        void this.shellModel.pathCall(`/panes/${panel.id}/setActive`);
      }
      this.scheduleSessionSave();
    });
    api.onDidAddPanel(() => {
      this.scheduleSessionSave();
    });
    api.onDidRemovePanel((panel) => {
      if (this.applyingCoreState || this.closingFromCore.has(panel.id) || this.disposingWorkspace.has(record.id)) {
        return;
      }
      void this.shellModel.pathCall(`/panes/${panel.id}/close`).catch((error) => {
        console.warn(`failed to close pane '${panel.id}' via shellModel`, error);
      });
      this.scheduleSessionSave();
    });
    api.onDidLayoutChange(() => {
      this.scheduleSessionSave();
    });
  }

  private updateDocumentTitle() {
    const activeId = this.activeWorkspaceId;
    const activePanel = activeId ? this.outerApi?.getPanel(activeId) : null;
    const workspaceTitle = activePanel?.title ?? null;
    document.title = workspaceTitle ? `${this.appTitle} / ${workspaceTitle}` : this.appTitle;
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
      pendingInnerLayout: null,
      pendingPanes: null
    };
    this.workspaces.set(workspaceId, record);
    return record;
  }

  // ── Save path ──

  private serializeSessionLayouts(): FlmuxSessionSaveLayouts {
    const innerLayouts: Record<string, unknown | null> = {};
    for (const [workspaceId, record] of this.workspaces) {
      innerLayouts[workspaceId] = record.innerApi ? record.innerApi.toJSON() : null;
    }
    return {
      outerLayout: this.outerApi?.toJSON() ?? null,
      innerLayouts
    };
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
      if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
        return;
      }
      const layouts = this.serializeSessionLayouts();
      void this.hostProxy["flmux.session.save"](layouts).catch((error) => {
        console.warn("failed to persist flmux session layouts", error);
      });
    }, 250);
  }

  private async flushSessionSave(options: { preferBeacon?: boolean } = {}) {
    if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
      return;
    }
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    const layouts = this.serializeSessionLayouts();
    if (options.preferBeacon && this.saveLayoutsViaBeacon(layouts)) {
      return;
    }
    await this.hostProxy["flmux.session.save"](layouts);
  }

  private saveLayoutsViaBeacon(layouts: FlmuxSessionSaveLayouts): boolean {
    try {
      const payload = JSON.stringify(layouts);
      const endpoint = `${this.config.appOrigin}/api/session/save`;
      const body = new Blob([payload], { type: "application/json" });

      if (typeof navigator.sendBeacon === "function") {
        return navigator.sendBeacon(endpoint, body);
      }
      void fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true
      });
      return true;
    } catch {
      return false;
    }
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
