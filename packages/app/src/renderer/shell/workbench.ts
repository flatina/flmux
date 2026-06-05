import "dockview-core/dist/styles/dockview.css";
import {
  createDockview,
  themeAbyss,
  themeLight,
  type CreateComponentOptions,
  type DockviewApi,
  type DockviewGroupPanelApi,
  type DockviewPanelApi,
  type DockviewTheme,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type SerializedDockview
} from "dockview-core";

import type { PaneEdgeGroup } from "@flmux/core/shell";

function currentDockviewTheme(): DockviewTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light") return themeLight;
  if (explicit === "dark") return themeAbyss;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? themeLight : themeAbyss;
}
import "../styles.css";
import { setupDropIndicatorMasks } from "../maskHelper";
import {
  createWorkspaceBus,
  createWorkspaceStatusStore,
  isSafeBrowserPaneUrl,
  type WorkspaceStatusStore,
  PLACEHOLDER_PANE_KIND,
  type PaneWorkspaceContext,
  type SequencedShellCoreEvent,
  type ShellModelAPI,
  type ShellPaneRecordSnapshot,
  type WorkspaceBus
} from "@flmux/core/shell";
import { PaneRegistry, type PaneDescriptor } from "./paneRegistry";
import { clearPaneHeaderMenu } from "../external/paneTabMenuRegistry";
import { registerBuiltinPaneDescriptors } from "./builtinPaneDescriptors";
import {
  EmptyWorkspaceWatermark,
  NewPaneHeaderAction,
  PaneTabRenderer,
  WorkspaceHeaderActions,
  WorkspaceTabRenderer,
  humanizePaneKind
} from "./headerActions";
import type {
  SessionCap,
  FlmuxRendererBootstrapConfig,
  FlmuxSessionSaveLayouts,
  FlmuxSessionBootstrapResponse
} from "../../shared/rendererBridge";
import type { WorkspaceTabstripMode } from "../../shared/runtimeMode";
import { FlmuxTitlebar, type FlmuxTitlebarWorkspace } from "./titlebar";
import { resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import { createShellModelClientOverSession } from "./shellModelClient";
import { subscribeShellCoreEvents, pushShellCoreEvent } from "./shellEventBus";
import { buildPaneWorkspaceContext } from "./workspaceContext";

type PendingPane = {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown> | undefined;
};

type PaneAddedPayload = {
  paneId: string;
  workspaceId: string;
  snapshot: ShellPaneRecordSnapshot;
  params: Record<string, unknown> | undefined;
  place?: "within" | "left" | "right" | "above" | "below";
  referencePaneId?: string;
};

type WorkspaceRecord = {
  id: string;
  bus: WorkspaceBus;
  statusStore: WorkspaceStatusStore;
  outerPanelApi: DockviewPanelApi | null;
  innerApi: DockviewApi | null;
  innerHost: HTMLElement | null;
  innerResizeObserver: ResizeObserver | null;
  pendingInnerLayout: SerializedDockview | null;
  pendingPanes: PendingPane[] | null;
  /** Pane events that arrived while the mount was deferred — replayed in order after it. */
  pendingPaneEvents: Array<() => void> | null;
  edgeGroups: Map<PaneEdgeGroup, DockviewGroupPanelApi>;
  paneEdge: Map<string, PaneEdgeGroup>;
};

const OUTER_WORKSPACE_COMPONENT = "workspace";

function isReplayOverflow(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; retry?: { kind?: string } };
  return e.code === "failed_precondition" && e.retry?.kind === "after-resync";
}

// Mirrors webModeAuth.isPaneKindAllowed. undefined acl (desktop) = no gate.
function isPaneKindAllowed(
  acl: { allow: "*" | readonly string[]; deny: readonly string[] } | undefined,
  kind: string
): boolean {
  if (!acl) return true;
  if (acl.deny.includes(kind)) return false;
  return acl.allow === "*" || acl.allow.includes(kind);
}

export class FlmuxWorkbench {
  readonly shellModel: ShellModelAPI;

  private readonly shellEl = document.querySelector<HTMLElement>(".dockview-shell")!;
  private readonly browserPanelTemplate = document.getElementById("browser-panel-tpl") as HTMLTemplateElement;
  private readonly paneRegistry = new PaneRegistry();

  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly paneIdToKind = new Map<string, string>();
  // User-closed workspace: inner panes' onDidRemovePanel should skip /panes/{id}/close (parent teardown).
  private readonly disposingWorkspace = new Set<string>();
  private outerApi: DockviewApi | null = null;

  // Bootstrap + seq gate
  private bootstrapped = false;
  private lastAppliedSeq = 0;
  private eventBuffer: SequencedShellCoreEvent[] = [];

  // Mirrored app-level state (needed to render document title; core is authoritative)
  private appTitle: string;
  private activeWorkspaceId: string | null = null;

  // Suppresses dockview→pathCall while we are applying core-driven state to dockview
  private applyingCoreState = false;

  // Layout deltas → main (debounced sessionStore write). Pagehide beacon flushes pending delta.
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;

  private readonly tabstripMode: WorkspaceTabstripMode;
  private titlebar: FlmuxTitlebar | null = null;

  constructor(
    private readonly config: FlmuxRendererBootstrapConfig,
    private readonly session: SessionCap
  ) {
    this.tabstripMode = config.workspaceTabstrip;
    this.appTitle = config.appName;
    registerBuiltinPaneDescriptors(this.paneRegistry, {
      installRoot: config.projectDir,
      resolveTerminalCwd: resolveTerminalCwdFromRoot
    });
    this.shellModel = createShellModelClientOverSession(session);
    subscribeShellCoreEvents((event) => this.handleCoreEvent(event));
    document.addEventListener("flmux-theme-change", () => this.applyDockviewTheme());
  }

  private applyDockviewTheme() {
    const theme = currentDockviewTheme();
    this.outerApi?.updateOptions({ theme });
    for (const record of this.workspaces.values()) {
      record.innerApi?.updateOptions({ theme });
    }
  }

  registerExternalPane(descriptor: PaneDescriptor) {
    this.paneRegistry.register(descriptor);
  }

  // Programmatic outer-tab activation; dockview synthetic-click / setActive() are unreliable for this RPC.
  setActiveWorkspace(workspaceId: string): void {
    void this.shellModel.pathCall(`/workspaces/${workspaceId}/setActive`);
  }

  private outerTabstripVisible(): boolean {
    switch (this.tabstripMode) {
      case "outer-always":
        return true;
      case "outer-auto":
        // Hide whenever there's a single workspace, empty or not. An empty
        // inner dockview shows its watermark (with an add-pane affordance),
        // so the outer tabstrip no longer needs to be the empty-state fallback.
        return this.workspaces.size >= 2;
      case "titlebar":
      case "none":
        return false;
    }
  }

  private syncOuterTabstripVisibility(): void {
    const hide = !this.outerTabstripVisible();
    this.shellEl.classList.toggle("flmux-outer-tabstrip-hidden", hide);
    this.syncTitlebarTabs();
  }

  private usesInnerPrefixMenus(): boolean {
    return this.tabstripMode === "outer-auto" || this.tabstripMode === "none";
  }

  private listMenuKinds(): Array<{ kind: string; label: string; iconUrl?: string }> {
    const acl = this.config.allowedPaneKinds;
    return this.paneRegistry
      .list()
      .filter((d) => d.kind !== PLACEHOLDER_PANE_KIND && d.newMenu !== false && isPaneKindAllowed(acl, d.kind))
      .map((d) => ({ kind: d.kind, label: d.defaultTitle ?? humanizePaneKind(d.kind), iconUrl: d.iconUrl }));
  }

  private maybeMountTitlebar() {
    if (this.tabstripMode !== "titlebar") return;
    const host = document.querySelector<HTMLElement>(".flmux-titlebar-host");
    if (!host) return;
    this.titlebar = new FlmuxTitlebar({
      listKinds: () => this.listMenuKinds(),
      onAddPane: (kind, workspaceId) => {
        void this.shellModel.pathCall("/panes/new", { kind, workspaceId, place: "right" });
      },
      onNewWorkspace: () => {
        void this.shellModel.pathCall("/workspaces/new");
      },
      onResetWorkspace: (id) => {
        void this.shellModel.pathCall(`/workspaces/${id}/reset`);
      },
      onCloseWorkspace: (id) => {
        void this.shellModel.pathCall(`/workspaces/${id}/delete`);
      },
      onActivateWorkspace: (id) => {
        void this.shellModel.pathCall(`/workspaces/${id}/setActive`);
      }
    });
    host.append(this.titlebar.element);
    document.body.classList.add("flmux-has-titlebar");
  }

  private syncTitlebarTabs() {
    if (!this.titlebar) return;
    const list: FlmuxTitlebarWorkspace[] = [];
    if (this.outerApi) {
      for (const panel of this.outerApi.panels) {
        list.push({ id: panel.id, title: panel.title ?? panel.id });
      }
    } else {
      for (const id of this.workspaces.keys()) list.push({ id, title: id });
    }
    this.titlebar.setWorkspaces(list, this.activeWorkspaceId);
  }

  async start() {
    this.maybeMountTitlebar();
    this.initializeOuterShell();

    const bootstrap = await this.session.bootstrap();
    this.applyBootstrap(bootstrap);
    this.lastAppliedSeq = bootstrap.seqStart;
    this.bootstrapped = true;
    // resumeToken cookie → tab refresh reuses same session slot within grace.
    document.cookie = `flmux-session=${encodeURIComponent(bootstrap.resumeToken)}; Path=/; SameSite=Strict`;

    this.drainBufferedEvents();
    this.openShellEventsStream();

    this.updateDocumentTitle();
    setupDropIndicatorMasks();

    this.sessionPersistenceEnabled = true;
    window.addEventListener("pagehide", () => {
      if (this.sessionPersistenceSuppressed) return;
      this.saveLayoutsViaBeacon(this.serializeSessionLayouts());
    });
  }

  // ── Bootstrap ──

  private applyBootstrap(bootstrap: FlmuxSessionBootstrapResponse) {
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
      this.syncOuterTabstripVisibility();
    } finally {
      this.sessionPersistenceSuppressed = false;
      this.applyingCoreState = priorApplying;
    }
  }

  private rebuildOuterFromSnapshot(bootstrap: FlmuxSessionBootstrapResponse) {
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
    this.pushLayout();
  }

  private applyWorkspaceAdded(payload: { id: string; title: string; defaultTitle: string }) {
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
    this.syncOuterTabstripVisibility();
  }

  private applyWorkspaceRemoved(payload: { id: string }) {
    this.outerApi?.getPanel(payload.id)?.api.close();
    const removed = this.workspaces.get(payload.id);
    removed?.statusStore.dispose();
    this.workspaces.delete(payload.id);
    this.syncOuterTabstripVisibility();
  }

  private applyWorkspaceTitleChanged(payload: { id: string; title: string }) {
    this.outerApi?.getPanel(payload.id)?.api.setTitle(payload.title);
    if (payload.id === this.activeWorkspaceId) {
      this.updateDocumentTitle();
    }
    this.syncTitlebarTabs();
  }

  private applyWorkspaceActiveChanged(payload: { id: string | null }) {
    this.activeWorkspaceId = payload.id;
    if (payload.id) {
      this.outerApi?.getPanel(payload.id)?.api.setActive();
    }
    this.syncOuterTabstripVisibility();
    this.updateDocumentTitle();
  }

  // Pane events for a workspace whose mount is still deferred are queued in
  // arrival order and replayed after it — applied directly they would be wiped
  // or duplicated by the upcoming fromJSON / pendingPanes mount (or silently
  // dropped, resurrecting removed panes on replay).
  private deferPaneEvent(record: WorkspaceRecord, replay: () => void): boolean {
    if (!record.pendingInnerLayout && !record.pendingPanes) {
      return false;
    }
    (record.pendingPaneEvents ??= []).push(replay);
    return true;
  }

  private applyPaneAdded(payload: PaneAddedPayload) {
    const record = this.workspaces.get(payload.workspaceId);
    // Drop silently if outer panel hasn't materialized yet — pane re-mounts later.
    if (!record?.innerApi) {
      return;
    }
    if (this.deferPaneEvent(record, () => this.applyPaneAdded(payload))) {
      return;
    }
    if (record.innerApi.getPanel(payload.paneId)) {
      return;
    }
    // Set BEFORE addPanel: tab renderer's init() reads this map synchronously.
    this.paneIdToKind.set(payload.paneId, payload.snapshot.kind);

    const descriptor = this.paneRegistry.get(payload.snapshot.kind);
    const edge = descriptor?.edgeGroup;
    if (edge) {
      this.addPaneToEdgeGroup(record, edge, {
        id: payload.paneId,
        kind: payload.snapshot.kind,
        title: payload.snapshot.title,
        params: payload.params
      });
      this.syncOuterTabstripVisibility();
      return;
    }

    // Stale ref → activePanel fallback. Absent → root-level split (column-fill helper relies on this).
    const resolved = payload.referencePaneId
      ? (record.innerApi.getPanel(payload.referencePaneId) ?? record.innerApi.activePanel)
      : null;
    // An edge-pane ref (e.g. the edge group's own `+`) would land a non-edge pane in the narrow edge group.
    const refIsEdge = !!resolved && record.paneEdge.has(resolved.id);
    let position =
      payload.place && !refIsEdge
        ? resolved
          ? { referencePanel: resolved, direction: payload.place }
          : { direction: payload.place }
        : undefined;
    // No usable ref: anchor to a non-edge panel, or split the root grid when the main area is empty.
    if (!position) {
      const activeId = record.innerApi.activePanel?.id;
      if (!activeId || record.paneEdge.has(activeId)) {
        const mainAnchor = record.innerApi.panels.find((p) => !record.paneEdge.has(p.id));
        position = mainAnchor ? { referencePanel: mainAnchor, direction: "within" } : { direction: "right" };
      }
    }
    record.innerApi.addPanel({
      id: payload.paneId,
      component: payload.snapshot.kind,
      title: payload.snapshot.title,
      params: payload.params,
      position,
      ...this.paneAddPanelConstraints(payload.snapshot.kind)
    });
    this.syncOuterTabstripVisibility();
  }

  private rehydrateEdgeGroupsFromLayout(
    record: WorkspaceRecord,
    layout: { panels?: Record<string, { contentComponent?: string }> }
  ) {
    if (!record.innerApi) return;
    for (const pos of ["left", "right", "top", "bottom"] as const) {
      const api = record.innerApi.getEdgeGroup(pos);
      if (api) this.trackEdgeGroup(record, pos, api);
    }
    for (const [paneId, state] of Object.entries(layout.panels ?? {})) {
      const edge = state.contentComponent ? this.paneRegistry.get(state.contentComponent)?.edgeGroup : undefined;
      if (edge) record.paneEdge.set(paneId, edge);
    }
  }

  // Register an edge group + persist its sash resizes: edge sashes live in the
  // shell splitview, not the grid, so they never fire onDidLayoutChange.
  private trackEdgeGroup(record: WorkspaceRecord, edge: PaneEdgeGroup, api: DockviewGroupPanelApi) {
    if (record.edgeGroups.get(edge) === api) return;
    record.edgeGroups.set(edge, api);
    let timer: ReturnType<typeof setTimeout> | null = null;
    api.onDidDimensionsChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Stale after detach/re-mount — the current instance owns persistence.
        if (!record.innerApi || record.edgeGroups.get(edge) !== api) return;
        this.pushLayout();
      }, 300);
    });
  }

  private addPaneToEdgeGroup(
    record: WorkspaceRecord,
    edge: PaneEdgeGroup,
    pane: { id: string; kind: string; title: string; params?: Record<string, unknown> }
  ) {
    const innerApi = record.innerApi!;
    let edgeApi = record.edgeGroups.get(edge) ?? innerApi.getEdgeGroup(edge);
    if (!edgeApi) {
      // First pane decides sizing; later panes ignored. Width for left/right, height for top/bottom.
      const d = this.paneRegistry.get(pane.kind);
      edgeApi = innerApi.addEdgeGroup(edge, {
        id: `edge-${record.id}-${edge}`,
        ...(d?.minimumSize !== undefined ? { minimumSize: d.minimumSize } : {}),
        ...(d?.maximumSize !== undefined ? { maximumSize: d.maximumSize } : {}),
        ...(d?.initialSize !== undefined ? { initialSize: d.initialSize } : {})
      });
    }
    this.trackEdgeGroup(record, edge, edgeApi);
    record.paneEdge.set(pane.id, edge);
    innerApi.addPanel({
      id: pane.id,
      component: pane.kind,
      title: pane.title,
      params: pane.params,
      position: { referenceGroup: edgeApi.id },
      ...this.paneAddPanelConstraints(pane.kind)
    });
  }

  private paneAddPanelConstraints(kind: string): {
    minimumWidth?: number;
    maximumWidth?: number;
    initialWidth?: number;
  } {
    // flmux *Size → Dockview *Width (column flow, orientation-agnostic).
    const descriptor = this.paneRegistry.get(kind);
    const constraints: { minimumWidth?: number; maximumWidth?: number; initialWidth?: number } = {};
    if (descriptor?.minimumSize !== undefined) constraints.minimumWidth = descriptor.minimumSize;
    if (descriptor?.maximumSize !== undefined) constraints.maximumWidth = descriptor.maximumSize;
    if (descriptor?.initialSize !== undefined) constraints.initialWidth = descriptor.initialSize;
    return constraints;
  }

  private applyPaneRemoved(payload: { paneId: string; workspaceId: string }) {
    const record = this.workspaces.get(payload.workspaceId);
    if (record && this.deferPaneEvent(record, () => this.applyPaneRemoved(payload))) {
      return;
    }
    record?.innerApi?.getPanel(payload.paneId)?.api.close();
    this.paneIdToKind.delete(payload.paneId);
    clearPaneHeaderMenu(payload.paneId);
    // Dockview leaves empty edge groups (structural). Remove on last pane close.
    if (record?.innerApi) {
      const edge = record.paneEdge.get(payload.paneId);
      if (edge) {
        record.paneEdge.delete(payload.paneId);
        const stillUsed = Array.from(record.paneEdge.values()).some((e) => e === edge);
        if (!stillUsed) {
          record.innerApi.removeEdgeGroup(edge);
          record.edgeGroups.delete(edge);
        }
      }
    }
    // New-active arrives via separate scope=client pane.activeChanged.
    this.syncOuterTabstripVisibility();
  }

  private resolvePaneIcon(paneId: string): string | undefined {
    const kind = this.paneIdToKind.get(paneId);
    if (!kind) return undefined;
    return this.paneRegistry.get(kind)?.iconUrl;
  }

  private applyPaneTitleChanged(payload: { paneId: string; workspaceId: string; title: string }) {
    const record = this.workspaces.get(payload.workspaceId);
    if (record && this.deferPaneEvent(record, () => this.applyPaneTitleChanged(payload))) {
      return;
    }
    record?.innerApi?.getPanel(payload.paneId)?.api.setTitle(payload.title);
  }

  private applyPaneParamsChanged(payload: {
    paneId: string;
    workspaceId: string;
    params: Record<string, unknown> | undefined;
  }) {
    const record = this.workspaces.get(payload.workspaceId);
    if (record && this.deferPaneEvent(record, () => this.applyPaneParamsChanged(payload))) {
      return;
    }
    record?.innerApi?.getPanel(payload.paneId)?.api.updateParameters(payload.params ?? {});
  }

  private applyPaneActiveChanged(payload: { workspaceId: string; paneId: string | null }) {
    if (!payload.paneId) {
      return;
    }
    const record = this.workspaces.get(payload.workspaceId);
    if (!record) return;
    if (this.deferPaneEvent(record, () => this.applyPaneActiveChanged(payload))) {
      return;
    }
    const edge = record.paneEdge.get(payload.paneId);
    if (edge) {
      const edgeApi = record.edgeGroups.get(edge);
      if (edgeApi?.isCollapsed()) edgeApi.expand();
    }
    record.innerApi?.getPanel(payload.paneId)?.api.setActive();
  }

  // ── Outer-panel renderer helpers (called by WorkspaceOuterPanelRenderer) ──

  attachInnerDockview(record: WorkspaceRecord, host: HTMLElement, outerApi: DockviewPanelApi) {
    record.outerPanelApi = outerApi;
    record.innerHost = host;

    const innerApi = createDockview(host, {
      theme: currentDockviewTheme(),
      disableFloatingGroups: true,
      // OverlayRenderContainer: gridview restructure updates CSS, not DOM re-attach (preserves scrollTop).
      defaultRenderer: "always",
      defaultTabComponent: "pane-tab",
      // Empty inner dockview (0 groups) renders this — also the sole add-pane
      // affordance for an empty workspace (no group header → no inner `+`).
      createWatermarkComponent: () =>
        new EmptyWorkspaceWatermark({
          listKinds: () => this.listMenuKinds(),
          onSelect: (kind) => {
            void this.shellModel.pathCall("/panes/new", { kind, place: "right" });
          }
        }),
      createComponent: (options) => this.createInnerPanelRenderer(record, options),
      createTabComponent: (options) =>
        options.name === "pane-tab"
          ? new PaneTabRenderer({ resolveIconUrl: (paneId) => this.resolvePaneIcon(paneId) })
          : undefined,
      // Left slot = right after the tabs, before the void/flex space (dockview
      // appends pre → tabs → left → void → right). Puts the `+` beside the tabs
      // rather than the far-right edge.
      createLeftHeaderActionComponent: (group) =>
        new NewPaneHeaderAction(group, {
          listKinds: () => this.listMenuKinds(),
          onSelect: (kind) => {
            // Pin to this group's active panel — keeps panel-relative split
            // (root-level placement is reserved for the column-fill helper).
            void this.shellModel.pathCall("/panes/new", {
              kind,
              place: "right",
              referencePaneId: group.activePanel?.id
            });
          }
        }),
      createPrefixHeaderActionComponent: this.usesInnerPrefixMenus()
        ? (group) => {
            const action = new WorkspaceHeaderActions(
              group,
              {
                onAdd: () => {
                  void this.shellModel.pathCall("/workspaces/new");
                },
                onResetActive: () => {
                  if (!this.activeWorkspaceId) return;
                  void this.shellModel.pathCall(`/workspaces/${this.activeWorkspaceId}/reset`);
                }
              },
              this.config
            );
            action.element.classList.add("flmux-workspace-prefix-menus");
            return action;
          }
        : undefined
    });
    record.innerApi = innerApi;

    this.bindInnerDockviewEvents(record);
    this.mountPendingInner(record);

    const layoutInner = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (record.innerApi && width > 0 && height > 0) {
        record.innerApi.layout(width, height, true);
        // Retries a mount deferred for lack of real dims; no-op once mounted.
        this.mountPendingInner(record);
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
    if (!record.pendingInnerLayout && !record.pendingPanes) {
      return;
    }
    // Mounting resolves sizes against the component's current dims — at 0×0
    // (host not laid out yet) edge-group widths clamp to their minimums and,
    // on the fromJSON path, the clamped value then overwrites the saved
    // expanded size. Defer until layoutInner has fed real dims.
    const h = record.innerHost;
    if (!h || h.clientWidth === 0 || h.clientHeight === 0) {
      return;
    }
    // Feed the host dims explicitly — the attach-time call arrives before
    // layoutInner, so the component's internal size may still be 0×0 even
    // though the host element is laid out.
    record.innerApi.layout(h.clientWidth, h.clientHeight, true);
    const priorApplying = this.applyingCoreState;
    this.applyingCoreState = true;
    try {
      if (record.pendingInnerLayout) {
        try {
          // Pre-populate kind map: fromJSON synchronously builds tabs that read it.
          const layout = record.pendingInnerLayout as { panels?: Record<string, { contentComponent?: string }> };
          for (const [id, state] of Object.entries(layout.panels ?? {})) {
            if (state.contentComponent) this.paneIdToKind.set(id, state.contentComponent);
          }
          record.innerApi.fromJSON(record.pendingInnerLayout);
          this.rehydrateEdgeGroupsFromLayout(record, layout);
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
      }
      // Not else-if: panes queued while the layout mount was deferred
      // (applyPaneAdded) mount right after fromJSON.
      if (record.pendingPanes) {
        const innerApi = record.innerApi;
        let firstPanelId: string | null = null;
        for (const pane of record.pendingPanes) {
          this.paneIdToKind.set(pane.id, pane.kind);
          const edge = this.paneRegistry.get(pane.kind)?.edgeGroup;
          if (edge) {
            this.addPaneToEdgeGroup(record, edge, pane);
            continue;
          }
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
              : undefined,
            ...this.paneAddPanelConstraints(pane.kind)
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
      // Replay pane events queued during the deferral — normal path now
      // (pending state cleared), so placement and dedupe apply as usual.
      const queued = record.pendingPaneEvents;
      record.pendingPaneEvents = null;
      if (queued) {
        for (const replay of queued) {
          replay();
        }
      }
    } finally {
      this.applyingCoreState = priorApplying;
    }
    this.syncOuterTabstripVisibility();
  }

  detachInnerDockview(record: WorkspaceRecord) {
    record.innerResizeObserver?.disconnect();
    record.innerResizeObserver = null;
    record.innerApi?.dispose();
    record.innerApi = null;
    record.innerHost = null;
    record.outerPanelApi = null;
    record.edgeGroups.clear();
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
    const record = this.workspaces.get(workspaceId);
    if (!record) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    return buildPaneWorkspaceContext({
      workspaceId,
      bus: record.bus,
      appOrigin: this.config.appOrigin
    });
  }

  private initializeOuterShell() {
    this.shellEl.replaceChildren();
    this.workspaces.clear();

    this.outerApi = createDockview(this.shellEl, {
      theme: currentDockviewTheme(),
      disableFloatingGroups: true,
      defaultRenderer: "always",
      // Workspace tab hamburger lets empty workspaces add panes (inner `+` only on groups).
      defaultTabComponent: "workspace-tab",
      createComponent: (options) => this.createOuterPanelRenderer(options),
      createTabComponent: (options) =>
        options.name === "workspace-tab"
          ? new WorkspaceTabRenderer({
              listKinds: () => this.listMenuKinds(),
              onSelect: (kind, workspaceId) => {
                void this.shellModel.pathCall("/panes/new", {
                  kind,
                  workspaceId,
                  place: "right"
                });
              }
            })
          : undefined,
      createRightHeaderActionComponent: (group) =>
        new WorkspaceHeaderActions(
          group,
          {
            onAdd: () => {
              void this.shellModel.pathCall("/workspaces/new");
            },
            onResetActive: () => {
              if (!this.activeWorkspaceId) {
                return;
              }
              void this.shellModel.pathCall(`/workspaces/${this.activeWorkspaceId}/reset`);
            }
          },
          this.config
        )
    });

    this.outerApi.onDidActivePanelChange((panel) => {
      if (this.applyingCoreState) {
        return;
      }
      if (panel) {
        void this.shellModel.pathCall(`/workspaces/${panel.id}/setActive`);
      }
      this.pushLayout();
    });
    this.outerApi.onDidLayoutChange(() => {
      this.pushLayout();
    });
    this.outerApi.onDidRemovePanel((panel) => {
      if (this.applyingCoreState || this.disposingWorkspace.has(panel.id)) {
        return;
      }
      // Guard spans the pathCall: dockview disposal cascade fires before it resolves.
      this.disposingWorkspace.add(panel.id);
      void this.shellModel
        .pathCall(`/workspaces/${panel.id}/delete`)
        .catch((error) => {
          console.warn(`failed to delete workspace '${panel.id}' via shellModel`, error);
        })
        .finally(() => {
          this.disposingWorkspace.delete(panel.id);
        });
      this.pushLayout();
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

  private openShellEventsStream() {
    void (async () => {
      try {
        for await (const event of this.session.events({ sinceSeq: this.lastAppliedSeq })) {
          pushShellCoreEvent(event);
        }
      } catch (error) {
        // Replay overflow → reload for fresh session.
        if (isReplayOverflow(error)) {
          console.warn("[flmux] replay overflow — reloading to resync");
          window.location.reload();
          return;
        }
        console.warn("[flmux] session.events stream ended", error);
      }
    })();
  }

  private subscribeTerminalEvents(paneId: string, handler: (event: TerminalRuntimeEvent) => void): () => void {
    const stream = this.session.terminalEvents({ paneId });
    let aborted = false;
    void (async () => {
      try {
        for await (const event of stream) {
          if (aborted) break;
          handler(event);
        }
      } catch (error) {
        if (!aborted) console.warn(`[flmux] terminal stream for ${paneId} ended:`, error);
      }
    })();
    return () => {
      aborted = true;
      stream.cancel();
    };
  }

  // Explorer header label: signed-in user (web) or the project dir name (desktop).
  private explorerUserLabel(): string {
    const account = this.config.account;
    if (account) return account.displayName ?? account.name;
    const dir = this.config.projectDir.replace(/[\\/]+$/, "");
    return (
      dir
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() || "Files"
    );
  }

  private createInnerPanelRenderer(record: WorkspaceRecord, options: CreateComponentOptions): IContentRenderer {
    const descriptor = this.requirePaneDescriptor(String(options.name));
    return descriptor.createRenderer({
      workspace: this.toWorkspaceContext(record.id),
      options,
      runtime: {
        shellModel: this.shellModel,
        browserPanelTemplate: this.browserPanelTemplate,
        subscribeTerminalEvents: (paneId, handler) => this.subscribeTerminalEvents(paneId, handler),
        workspaceStatus: record.statusStore,
        normalizeBrowserUrl: (value) => this.normalizeBrowserUrlFromInput(value),
        onBrowserUrlChange: (paneId, url) => {
          void this.shellModel.pathSet(`/panes/${paneId}/browser/url`, url).catch((error) => {
            console.warn(`failed to propagate browser url change for pane '${paneId}'`, error);
          });
        },
        userLabel: this.explorerUserLabel()
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
        void this.shellModel.pathCall(`/panes/${panel.id}/setActive`, { source: "user" });
      }
      this.pushLayout();
    });
    api.onDidAddPanel(() => {
      this.pushLayout();
    });
    api.onDidRemovePanel((panel) => {
      if (this.applyingCoreState || this.disposingWorkspace.has(record.id)) {
        return;
      }
      void this.shellModel.pathCall(`/panes/${panel.id}/close`).catch((error) => {
        console.warn(`failed to close pane '${panel.id}' via shellModel`, error);
      });
      this.pushLayout();
    });
    api.onDidLayoutChange(() => {
      this.pushLayout();
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
    const resolved = trimmed.includes("://")
      ? trimmed
      : trimmed.startsWith("/")
        ? `${this.config.appOrigin}${trimmed}`
        : `${prefersHttpScheme(trimmed) ? "http" : "https"}://${trimmed}`;
    return isSafeBrowserPaneUrl(resolved) ? resolved : null;
  }

  private createWorkspaceRecord(workspaceId: string): WorkspaceRecord {
    const existing = this.workspaces.get(workspaceId);
    if (existing) {
      return existing;
    }
    const record: WorkspaceRecord = {
      id: workspaceId,
      // Renderer-local bus (cross-client broadcast deferred — architecture).
      bus: createWorkspaceBus(workspaceId),
      statusStore: createWorkspaceStatusStore(),
      outerPanelApi: null,
      innerApi: null,
      innerHost: null,
      innerResizeObserver: null,
      pendingInnerLayout: null,
      pendingPanes: null,
      pendingPaneEvents: null,
      edgeGroups: new Map(),
      paneEdge: new Map()
    };
    this.workspaces.set(workspaceId, record);
    return record;
  }

  // ── Save path ──

  private serializeSessionLayouts(): FlmuxSessionSaveLayouts {
    const innerLayouts: Record<string, unknown | null> = {};
    for (const [workspaceId, record] of this.workspaces) {
      // A still-deferred mount (host never laid out, e.g. background workspace)
      // holds its state in pendingInnerLayout/pendingPanes — serializing the
      // empty dockview instead would wipe the saved layout (an empty-grid save
      // would also shadow the snapshot-pane fallback on the next bootstrap).
      innerLayouts[workspaceId] =
        record.pendingInnerLayout ?? (record.pendingPanes ? null : record.innerApi ? record.innerApi.toJSON() : null);
    }
    return {
      outerLayout: this.outerApi?.toJSON() ?? null,
      innerLayouts
    };
  }

  private pushLayout() {
    if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
      return;
    }
    const layouts = this.serializeSessionLayouts();
    void this.session.pushLayout(layouts).catch((error: unknown) => {
      console.warn("failed to push flmux layout delta", error);
    });
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

  constructor(
    private readonly workspaceId: string,
    private readonly workbench: FlmuxWorkbench
  ) {
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
