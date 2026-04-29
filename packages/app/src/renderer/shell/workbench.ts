import "dockview-core/dist/styles/dockview.css";
import {
  createDockview,
  themeAbyss,
  themeLight,
  type CreateComponentOptions,
  type DockviewApi,
  type DockviewPanelApi,
  type DockviewTheme,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type SerializedDockview
} from "dockview-core";

function currentDockviewTheme(): DockviewTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light") return themeLight;
  if (explicit === "dark") return themeAbyss;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? themeLight : themeAbyss;
}
import "../styles.css";
import { setupDropIndicatorMasks } from "../maskHelper";
import { createTerminalHost } from "../terminalHost";
import {
  createWorkspaceBus,
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
  NewPaneHeaderAction,
  PaneTabRenderer,
  WorkspaceHeaderActions,
  WorkspaceTabRenderer,
  humanizePaneKind
} from "./headerActions";
import type {
  FlmuxHostRequestProxy,
  FlmuxRendererBootstrapConfig,
  FlmuxSessionSaveLayouts,
  FlmuxShellBootstrapResponse
} from "../../shared/rendererBridge";
import { getFlmuxRendererLifecyclePolicy } from "../../shared/runtimeMode";
import { resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";
import { createShellModelClientOverPreload } from "./shellModelClient";
import { subscribeShellCoreEvents } from "./shellEventBus";
import { buildPaneWorkspaceContext } from "./workspaceContext";

type PendingPane = {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown> | undefined;
};

type WorkspaceRecord = {
  id: string;
  bus: WorkspaceBus;
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
  private readonly paneIdToKind = new Map<string, string>();
  // disposingWorkspace covers the user-originated outer-panel-close path where
  // applyingCoreState is false but dockview's synchronous inner-disposal
  // cascade needs inner onDidRemovePanel handlers to skip /panes/{id}/close.
  private readonly disposingWorkspace = new Set<string>();
  private outerApi: DockviewApi | null = null;

  // Bootstrap + seq gate
  private bootstrapped = false;
  private lastAppliedSeq = 0;
  private eventBuffer: SequencedShellCoreEvent[] = [];

  // Mirrored app-level state (needed to render document title; core is authoritative)
  private appTitle = "flmux";
  private activeWorkspaceId: string | null = null;

  // Suppresses dockview→pathCall while we are applying core-driven state to dockview
  private applyingCoreState = false;

  // Session persistence: renderer pushes layout deltas on every change via
  // `flmux.layout.push`; main debounces + writes via `sessionStore`. The
  // pagehide beacon is the last-chance flush for an in-flight push that
  // might not make it over the wire before the tab/window closes.
  private sessionPersistenceEnabled = false;
  private sessionPersistenceSuppressed = false;

  constructor(
    private readonly config: FlmuxRendererBootstrapConfig,
    private readonly hostProxy: FlmuxHostRequestProxy
  ) {
    this.lifecyclePolicy = getFlmuxRendererLifecyclePolicy(config.mode);
    this.terminalHost = createTerminalHost();
    registerBuiltinPaneDescriptors(this.paneRegistry, {
      installRoot: config.projectDir,
      resolveTerminalCwd: resolveTerminalCwdFromRoot
    });
    this.shellModel = createShellModelClientOverPreload(hostProxy);
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

  // Programmatic outer-tab activation. Skips dockview entirely and drives
  // the same `shellModel.pathCall` the `onDidActivePanelChange` handler
  // would invoke — routes through preload/WS so `hostRequests.ts` injects
  // `caller.attachmentId`. Dockview's synthetic-click and
  // `panel.api.setActive()` paths don't reliably reach this RPC.
  setActiveWorkspace(workspaceId: string): void {
    void this.shellModel.pathCall(`/workspaces/${workspaceId}/setActive`);
  }

  async start() {
    this.initializeOuterShell();

    if (this.config.mode === "web") {
      // Web: HTTP POST bootstrap mints the attachmentId server-side and
      // installs the ring-buffer subscriber; apply snapshot; THEN register
      // with the attachmentId so the server flushes any replay + installs
      // the live forwarder. Order matters — forwarder can't exist before
      // attachmentId does.
      const bootstrap = await this.fetchWebBootstrap();
      this.applyBootstrap(bootstrap);
      this.lastAppliedSeq = bootstrap.seqStart;
      this.bootstrapped = true;
      // `register` RPC and `shellCore.event` messages share one ordered WS
      // stream — server-side replay events sent inside the register
      // handler arrive on the same socket before the register response,
      // so bootstrapped=true + lastAppliedSeq must be set above. If a
      // future refactor routes register through a separate transport
      // this ordering assumption dies and events can arrive before the
      // gate is armed.
      const registration = await this.hostProxy["flmux.client.register"]({
        attachmentId: bootstrap.attachmentId,
        lastAppliedSeq: bootstrap.seqStart
      });
      if (registration.status === "rebootstrap-required") {
        // Ring buffer overflowed between bootstrap and register (rare in
        // B1d single-attachment; possible under server-side event storms).
        // Simplest recovery: reload the page to restart the cycle.
        console.warn("[flmux] rebootstrap-required on first register — reloading");
        window.location.reload();
        return;
      }
    } else {
      // Desktop: register first (installs forwarder on the pinned "local"
      // attachment), then preload-RPC bootstrap. Live events emitted during
      // bootstrap reach the renderer and are buffered by the seq gate.
      // Desktop register never carries a binding arg → server-side
      // `onClientRegister` returns void → response is always `"ok"`. The
      // `"rebootstrap-required"` branch only arises for web. A pinned test
      // in `hostRequests.test.ts` guards the invariant.
      const registration = await this.hostProxy["flmux.client.register"]({});
      if (registration.status !== "ok") {
        throw new Error(`flmux.client.register: desktop preload returned unexpected status '${registration.status}'`);
      }
      const bootstrap = await this.hostProxy["flmux.shellBootstrap"]();
      this.applyBootstrap(bootstrap);
      this.lastAppliedSeq = bootstrap.seqStart;
      this.bootstrapped = true;
    }
    this.drainBufferedEvents();

    this.updateDocumentTitle();
    setupDropIndicatorMasks();

    if (this.lifecyclePolicy.persistSession) {
      this.sessionPersistenceEnabled = true;
      // Pagehide beacon: last-chance flush. Main's 250 ms debounce might
      // hold a pending delta when the tab/window goes away; beacon POSTs
      // the latest layout directly for an immediate write.
      window.addEventListener("pagehide", () => {
        if (this.sessionPersistenceSuppressed) return;
        this.saveLayoutsViaBeacon(this.serializeSessionLayouts());
      });
    }
  }

  private async fetchWebBootstrap(): Promise<FlmuxShellBootstrapResponse> {
    const response = await fetch(`${this.config.appOrigin}/api/shell/bootstrap`, {
      method: "POST",
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error(`/api/shell/bootstrap failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as FlmuxShellBootstrapResponse;
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
  }

  private applyWorkspaceRemoved(payload: { id: string }) {
    // applyingCoreState is already true, so outer/inner onDidRemovePanel
    // callbacks fired by dockview's disposal cascade short-circuit before
    // the pathCall branch — no extra guard needed here. A follow-up
    // workspace.activeChanged (scope=attachment, target=this attachment)
    // re-points outer setActive; this handler just closes the panel.
    this.outerApi?.getPanel(payload.id)?.api.close();
    this.workspaces.delete(payload.id);
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
    // Drop silently if outer panel hasn't materialized yet — pane re-mounts later.
    if (!record?.innerApi) {
      return;
    }
    if (record.innerApi.getPanel(payload.paneId)) {
      return;
    }
    // Stale referencePaneId → fall back to activePanel. Absent → root-level split
    // (column-fill helper's "new column" relies on this).
    const referencePanel = payload.referencePaneId
      ? record.innerApi.getPanel(payload.referencePaneId) ?? record.innerApi.activePanel
      : null;
    const position = payload.place
      ? referencePanel
        ? { referencePanel, direction: payload.place }
        : { direction: payload.place }
      : undefined;
    // Set BEFORE addPanel — addPanel synchronously triggers the tab
    // renderer's init() → applyIcon(), which reads this map.
    this.paneIdToKind.set(payload.paneId, payload.snapshot.kind);
    record.innerApi.addPanel({
      id: payload.paneId,
      component: payload.snapshot.kind,
      title: payload.snapshot.title,
      params: payload.params,
      position
    });
  }

  private applyPaneRemoved(payload: { paneId: string; workspaceId: string }) {
    const record = this.workspaces.get(payload.workspaceId);
    record?.innerApi?.getPanel(payload.paneId)?.api.close();
    this.paneIdToKind.delete(payload.paneId);
    clearPaneHeaderMenu(payload.paneId);
    // New-active selection now arrives as a separate scope=attachment
    // pane.activeChanged — this handler only closes the panel.
  }

  private resolvePaneIcon(paneId: string): string | undefined {
    const kind = this.paneIdToKind.get(paneId);
    if (!kind) return undefined;
    return this.paneRegistry.get(kind)?.iconUrl;
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
      theme: currentDockviewTheme(),
      disableFloatingGroups: true,
      defaultTabComponent: "pane-tab",
      createComponent: (options) => this.createInnerPanelRenderer(record, options),
      createTabComponent: (options) =>
        options.name === "pane-tab"
          ? new PaneTabRenderer({ resolveIconUrl: (paneId) => this.resolvePaneIcon(paneId) })
          : undefined,
      createRightHeaderActionComponent: (group) =>
        new NewPaneHeaderAction(group, {
          listKinds: () =>
            this.paneRegistry
              .list()
              .filter((descriptor) => descriptor.kind !== PLACEHOLDER_PANE_KIND)
              .map((descriptor) => ({
                kind: descriptor.kind,
                label: descriptor.defaultTitle ?? humanizePaneKind(descriptor.kind),
                iconUrl: descriptor.iconUrl
              })),
          onSelect: (kind) => {
            // Pin to this group's active panel so the workbench stays on
            // the panel-relative split path — without it, the absent-ref
            // fallback now falls through to Dockview's root-level
            // absolute placement (used by the column-fill helper for
            // new-column cases) which would change inner-`+` UX.
            void this.shellModel.pathCall("/panes/new", {
              kind,
              place: "right",
              referencePaneId: group.activePanel?.id
            });
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
          // Pre-populate kind map BEFORE fromJSON — fromJSON synchronously
          // builds tabs (each running PaneTabRenderer.init → applyIcon),
          // which read this map.
          const layout = record.pendingInnerLayout as { panels?: Record<string, { contentComponent?: string }> };
          for (const [id, state] of Object.entries(layout.panels ?? {})) {
            if (state.contentComponent) this.paneIdToKind.set(id, state.contentComponent);
          }
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
          // Set BEFORE addPanel — see applyPaneAdded for the same ordering.
          this.paneIdToKind.set(pane.id, pane.kind);
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
      // Workspace tabs get a hamburger menu before the title so panes can
      // be added to a workspace whose inner Dockview is empty (the inner
      // `+` only renders on a group, and we don't auto-seed a placeholder
      // group on the last-pane-removed event).
      defaultTabComponent: "workspace-tab",
      createComponent: (options) => this.createOuterPanelRenderer(options),
      createTabComponent: (options) =>
        options.name === "workspace-tab"
          ? new WorkspaceTabRenderer({
              listKinds: () =>
                this.paneRegistry
                  .list()
                  .filter((descriptor) => descriptor.kind !== PLACEHOLDER_PANE_KIND)
                  .map((descriptor) => ({
                    kind: descriptor.kind,
                    label: descriptor.defaultTitle ?? humanizePaneKind(descriptor.kind),
                    iconUrl: descriptor.iconUrl
                  })),
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
        new WorkspaceHeaderActions(group, {
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
      this.pushLayout();
    });
    this.outerApi.onDidLayoutChange(() => {
      this.pushLayout();
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
      // Renderer-local workspace bus. Extension panes publish+subscribe here
      // via their PaneWorkspaceContext.bus. Cross-client broadcast (main-side
      // publishers reaching renderer subscribers) is Phase B per plan v2.
      bus: createWorkspaceBus(workspaceId),
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

  private pushLayout() {
    if (!this.sessionPersistenceEnabled || this.sessionPersistenceSuppressed) {
      return;
    }
    const layouts = this.serializeSessionLayouts();
    void this.hostProxy["flmux.layout.push"](layouts).catch((error: unknown) => {
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
