import type { TerminalBackend } from "../terminal/backend";
import type { TerminalRuntimeEvent } from "../terminal/terminal";
import { resolveTerminalCwdFromRoot } from "../terminal/terminalPath";
import {
  PaneRegistry,
  createPaneSnapshot as createPaneSnapshotHelper,
  createPaneStateRecord,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  resolvePaneCreateParams,
  resolvePaneTitle,
  type PanePathMount,
  type PanePathMountContext,
  type PaneSpec,
  type PaneStateRecord,
  type PaneWorkspaceContext
} from "./panes";
import { createWorkspaceBus } from "./workspaceBus";
import type {
  AppStatusSnapshot,
  NewPaneInput,
  ScopedPropertyTarget,
  ShellModelHost,
  ShellPaneRecordSnapshot,
  ShellResolvedPanePathMount,
  ShellResolvedPaneSubtreeMount,
  ShellTerminalDelegate,
  WorkspaceBus,
  WorkspaceBusEvent,
  WorkspaceStatusSnapshot
} from "./types";

interface WorkspaceRecord {
  id: string;
  title: string;
  defaultTitle: string;
  defaultBrowserPath: string;
  bus: WorkspaceBus;
  paneOrder: string[];
  paneTitles: Map<string, string>;
  paneStates: Map<string, PaneStateRecord>;
  paneParams: Map<string, Record<string, unknown> | undefined>;
  activePaneId: string | null;
}

export interface ShellCoreOptions {
  paneRegistry: PaneRegistry<PaneSpec>;
  runtimeLabel: string;
  /** Install root used to resolve terminal cwd and as the ptyd root. */
  projectDir: string;
  terminalBackend: TerminalBackend;
  initialAppOrigin?: string;
}

export class ShellCore implements ShellModelHost {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly paneWorkspaceIds = new Map<string, string>();
  private appTitle = "flmux";
  private appOrigin: string;
  private activeWorkspaceId: string | null = null;

  constructor(private readonly options: ShellCoreOptions) {
    this.appOrigin = options.initialAppOrigin ?? "http://127.0.0.1:0";
  }

  initialize() {
    if (this.activeWorkspaceId) {
      return;
    }

    const workspace = this.createWorkspaceRecord("workspace.1", "Workspace 1");
    this.activeWorkspaceId = workspace.id;
    this.seedWorkspace(workspace);
  }

  /**
   * Create an empty workspace with an explicit id, without seeding default
   * panes. Used by the desktop workbench during session restore, where
   * dockview already holds the serialized panels — ShellCore just needs
   * the logical records rebuilt with the restored ids.
   */
  restoreWorkspace(input: { id: string; title: string; defaultTitle?: string; setActive?: boolean }) {
    const workspace = this.createWorkspaceRecord(input.id, input.title);
    if (input.defaultTitle) {
      workspace.defaultTitle = input.defaultTitle;
    }
    if (input.setActive || !this.activeWorkspaceId) {
      this.activeWorkspaceId = workspace.id;
    }
    return this.toWorkspaceStatus(workspace);
  }

  /**
   * Rebuild a pane state record with an explicit paneId (skipping the usual
   * UUID generation). Used during session restore to match ids already
   * materialized in the view layer.
   */
  restorePane(
    workspaceId: string,
    input: { paneId: string; kind: string; params?: Record<string, unknown>; title?: string }
  ): ShellPaneRecordSnapshot {
    const workspace = this.requireWorkspace(workspaceId);
    const spec = this.options.paneRegistry.get(input.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${input.kind}'`);
    }
    const workspaceContext = this.toWorkspaceContext(workspace);
    const params = spec.persistence?.normalizeRestoredParams?.({
      workspace: workspaceContext,
      params: input.params
    }) ?? input.params;

    const record = createPaneStateRecord({
      spec,
      workspace: workspaceContext,
      params
    });
    const normalizedParams = cloneJsonObject(params) ?? {};
    if (isBrowserPaneStateRecord(record)) {
      const nextUrl = normalizeBrowserUrl("", this.appOrigin, record.url, workspace.defaultBrowserPath);
      record.url = nextUrl;
      normalizedParams.url = nextUrl;
    }
    if (isTerminalPaneStateRecord(record)) {
      normalizedParams.cwd = record.cwd;
    }

    const title = input.title?.trim() || humanizePaneKind(input.kind);

    workspace.paneOrder.push(input.paneId);
    workspace.paneTitles.set(input.paneId, title);
    workspace.paneStates.set(input.paneId, record);
    workspace.paneParams.set(input.paneId, Object.keys(normalizedParams).length > 0 ? normalizedParams : params);
    workspace.activePaneId = input.paneId;
    this.paneWorkspaceIds.set(input.paneId, workspace.id);

    return this.createPaneSnapshot(workspace, input.paneId, title);
  }

  setActiveWorkspace(workspaceId: string | null) {
    if (workspaceId === null) {
      this.activeWorkspaceId = null;
      return;
    }
    this.requireWorkspace(workspaceId);
    this.activeWorkspaceId = workspaceId;
  }

  setActivePane(workspaceId: string, paneId: string | null) {
    const workspace = this.requireWorkspace(workspaceId);
    if (paneId !== null && !workspace.paneStates.has(paneId)) {
      throw new Error(`Pane '${paneId}' not found in workspace '${workspaceId}'`);
    }
    workspace.activePaneId = paneId;
  }

  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId;
  }

  setAppTitle(title: string) {
    this.appTitle = title;
  }

  getAppTitle(): string {
    return this.appTitle;
  }

  getWorkspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  setAppOrigin(origin: string) {
    const previousOrigin = this.appOrigin;
    this.appOrigin = origin;

    for (const workspace of this.workspaces.values()) {
      for (const paneId of workspace.paneOrder) {
        const pane = workspace.paneStates.get(paneId);
        if (!pane || !isBrowserPaneStateRecord(pane)) {
          continue;
        }

        const normalized = normalizeBrowserUrl(previousOrigin, this.appOrigin, pane.url, workspace.defaultBrowserPath);
        pane.url = normalized;
        workspace.paneParams.set(paneId, { url: normalized });
      }
    }
  }

  applyTerminalEvent(event: TerminalRuntimeEvent) {
    const paneId = event.paneId ?? null;
    if (!paneId) {
      return;
    }

    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return;
    }

    const pane = workspace.paneStates.get(paneId);
    if (!pane || !isTerminalPaneStateRecord(pane)) {
      return;
    }

    if (event.type === "state") {
      pane.cwd = event.terminal.cwd;
      pane.rootKey = event.terminal.rootKey;
      pane.runtimeId = event.terminal.runtimeId;
      pane.summary = event.terminal;
      return;
    }

    if (event.type === "removed") {
      pane.rootKey = null;
      pane.runtimeId = null;
      pane.summary = null;
    }
  }

  createTerminalDelegate(): ShellTerminalDelegate {
    const projectDir = this.options.projectDir;
    const backend = this.options.terminalBackend;
    return {
      attachRuntime: async (paneId, input) => {
        const { workspace, pane } = this.requireTerminalPane(paneId);
        if (pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' already has an attached runtime`);
        }

        const adopt = await backend.adoptByPaneId({
          rootDir: projectDir,
          paneId
        });
        if (adopt.outcome === "adopted") {
          pane.cwd = adopt.terminal.cwd;
          pane.rootKey = adopt.rootKey;
          pane.runtimeId = adopt.runtimeId;
          pane.summary = adopt.terminal;
          workspace.paneParams.set(paneId, { cwd: pane.cwd });
          return {
            ok: true,
            rootKey: adopt.rootKey,
            runtimeId: adopt.runtimeId,
            history: adopt.history,
            terminal: adopt.terminal
          };
        }

        const result = await backend.create({
          paneId,
          rootDir: projectDir,
          cwd: resolveTerminalCwdFromRoot(projectDir, input.cwd ?? pane.cwd)
        });
        pane.cwd = result.terminal.cwd;
        pane.rootKey = result.rootKey;
        pane.runtimeId = result.runtimeId;
        pane.summary = result.terminal;
        workspace.paneParams.set(paneId, { cwd: pane.cwd });
        return result;
      },
      writeRuntime: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.write({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          data: input.data
        });
        if (result.terminal) {
          pane.summary = result.terminal;
        }
        return result;
      },
      resizeRuntime: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.resize({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          cols: input.cols,
          rows: input.rows
        });
        if (result.terminal) {
          pane.summary = result.terminal;
        }
        return result;
      },
      readHistory: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        return await backend.history({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          maxBytes: input.maxBytes
        });
      },
      killRuntime: async (paneId) => {
        const { workspace, pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.kill({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId
        });
        pane.rootKey = null;
        pane.runtimeId = null;
        pane.summary = null;
        workspace.paneParams.set(paneId, { cwd: pane.cwd });
        return result;
      }
    };
  }

  // ── ShellModelHost implementation ──

  async getAppStatus(): Promise<AppStatusSnapshot> {
    return {
      title: this.appTitle,
      origin: this.appOrigin,
      runtimeLabel: this.options.runtimeLabel
    };
  }

  async listWorkspaces(): Promise<WorkspaceStatusSnapshot[]> {
    return [...this.workspaces.values()].map((workspace) => this.toWorkspaceStatus(workspace));
  }

  async createWorkspace(input: { title?: string } = {}): Promise<WorkspaceStatusSnapshot> {
    const descriptor = this.allocateWorkspaceDescriptor(input.title);
    const workspace = this.createWorkspaceRecord(descriptor.id, descriptor.title);
    this.activeWorkspaceId = workspace.id;
    this.seedWorkspace(workspace);
    return this.toWorkspaceStatus(workspace);
  }

  async resetWorkspace(workspaceId: string): Promise<WorkspaceStatusSnapshot> {
    const workspace = this.requireWorkspace(workspaceId);
    for (const paneId of [...workspace.paneOrder]) {
      await this.closePane(paneId);
    }
    workspace.title = workspace.defaultTitle;
    this.seedWorkspace(workspace);
    return this.toWorkspaceStatus(workspace);
  }

  async getWorkspaceStatus(): Promise<WorkspaceStatusSnapshot> {
    return this.toWorkspaceStatus(this.requireCurrentWorkspace());
  }

  async hasPaneKind(kind: string): Promise<boolean> {
    return this.options.paneRegistry.get(kind) !== undefined;
  }

  async listPanes(): Promise<ShellPaneRecordSnapshot[]> {
    const workspace = this.requireCurrentWorkspace();
    return workspace.paneOrder.map((paneId) => this.createPaneSnapshot(workspace, paneId));
  }

  async getPane(paneId: string): Promise<ShellPaneRecordSnapshot | undefined> {
    const workspace = this.requireCurrentWorkspace();
    if (!workspace.paneStates.has(paneId)) {
      return undefined;
    }
    return this.createPaneSnapshot(workspace, paneId);
  }

  async createPane(input: NewPaneInput): Promise<ShellPaneRecordSnapshot> {
    const workspace = this.requireCurrentWorkspace();
    return this.addPane(workspace, input);
  }

  async closePane(paneId: string): Promise<{ paneId: string; closed: boolean }> {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return { paneId, closed: false };
    }

    const pane = workspace.paneStates.get(paneId);
    if (pane && isTerminalPaneStateRecord(pane) && pane.rootKey && pane.runtimeId) {
      await this.options.terminalBackend.kill({
        rootKey: pane.rootKey,
        runtimeId: pane.runtimeId
      });
    }

    const closed = workspace.paneStates.delete(paneId);
    workspace.paneParams.delete(paneId);
    workspace.paneTitles.delete(paneId);
    workspace.paneOrder = workspace.paneOrder.filter((candidate) => candidate !== paneId);
    this.paneWorkspaceIds.delete(paneId);
    if (workspace.activePaneId === paneId) {
      workspace.activePaneId = workspace.paneOrder.at(-1) ?? null;
    }

    return { paneId, closed };
  }

  async setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown): Promise<{ value: unknown }> {
    if (key !== "title") {
      throw new Error(`Unsupported scoped property '${key}'`);
    }

    const nextValue = requiredString(value, `${target.scope} property '${key}'`);
    if (target.scope === "app") {
      this.appTitle = nextValue;
      return { value: nextValue };
    }

    if (target.scope === "workspace") {
      const workspace = target.workspaceId ? this.requireWorkspace(target.workspaceId) : this.requireCurrentWorkspace();
      workspace.title = nextValue;
      return { value: nextValue };
    }

    const workspace = this.findWorkspaceByPaneId(target.paneId);
    if (!workspace) {
      throw new Error(`Pane '${target.paneId}' not found`);
    }
    workspace.paneTitles.set(target.paneId, nextValue);
    return { value: nextValue };
  }

  async getPaneParams(paneId: string): Promise<Record<string, unknown> | undefined> {
    const workspace = this.findWorkspaceByPaneId(paneId);
    return cloneJsonObject(workspace?.paneParams.get(paneId));
  }

  async setPaneParams(paneId: string, nextParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { workspace, record } = this.lookupPane(paneId);
    const cloned = cloneJsonObject(nextParams) ?? {};
    if (isBrowserPaneStateRecord(record) && typeof cloned.url === "string") {
      const nextUrl = normalizeBrowserUrl("", this.appOrigin, cloned.url, workspace.defaultBrowserPath);
      record.url = nextUrl;
      workspace.paneParams.set(paneId, { ...cloned, url: nextUrl });
      return { ...cloned, url: nextUrl };
    }

    if (isTerminalPaneStateRecord(record) && typeof cloned.cwd === "string") {
      record.cwd = resolveTerminalCwdFromRoot(this.options.projectDir, cloned.cwd);
      workspace.paneParams.set(paneId, { cwd: record.cwd });
      return { cwd: record.cwd };
    }

    workspace.paneParams.set(paneId, cloned);
    return cloned;
  }

  async patchPaneParams(paneId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.setPaneParams(paneId, {
      ...(await this.getPaneParams(paneId) ?? {}),
      ...(cloneJsonObject(patch) ?? {})
    });
  }

  async getPaneSubtreeMounts(paneId: string): Promise<ShellResolvedPaneSubtreeMount[]> {
    const { workspace, record, spec } = this.lookupPane(paneId);
    return (spec.subtreeMounts ?? []).map((mount) => this.resolvePaneMount(workspace, paneId, record, mount));
  }

  async getPanePathMount(paneId: string): Promise<ShellResolvedPanePathMount | undefined> {
    const { workspace, record, spec } = this.lookupPane(paneId);
    return spec.pathMount ? this.resolvePaneMount(workspace, paneId, record, spec.pathMount) : undefined;
  }

  async publishWorkspaceEvent(input: { topic: string; sourcePaneId: string; payload: unknown }): Promise<WorkspaceBusEvent> {
    const workspace = this.requireWorkspaceForPane(input.sourcePaneId);
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

  // ── Internal helpers ──

  private resolvePaneMount(
    workspace: WorkspaceRecord,
    paneId: string,
    record: PaneStateRecord,
    mount: PanePathMount
  ): ShellResolvedPanePathMount {
    const createContext = (): PanePathMountContext => ({
      paneId,
      workspace: this.toWorkspaceContext(workspace),
      record,
      currentParams: workspace.paneParams.get(paneId),
      setParams: async (nextParams) => await this.setPaneParams(paneId, nextParams),
      patchParams: async (patch) => await this.patchPaneParams(paneId, patch)
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

  private requireCurrentWorkspace() {
    if (!this.activeWorkspaceId) {
      throw new Error("Shell core is not initialized");
    }

    return this.requireWorkspace(this.activeWorkspaceId);
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    return workspace;
  }

  private requireWorkspaceForPane(paneId: string) {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    return workspace;
  }

  private findWorkspaceByPaneId(paneId: string) {
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    return workspaceId ? this.workspaces.get(workspaceId) ?? null : null;
  }

  private requireTerminalPane(paneId: string) {
    const { workspace, record } = this.lookupPane(paneId);
    if (!isTerminalPaneStateRecord(record)) {
      throw new Error(`Pane '${paneId}' is not a terminal pane`);
    }
    return { workspace, pane: record };
  }

  private lookupPane(paneId: string): {
    workspace: WorkspaceRecord;
    record: PaneStateRecord;
    spec: PaneSpec;
  } {
    const workspace = this.requireWorkspaceForPane(paneId);
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    const spec = this.options.paneRegistry.get(record.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${record.kind}'`);
    }
    return { workspace, record, spec };
  }

  private toWorkspaceStatus(workspace: WorkspaceRecord): WorkspaceStatusSnapshot {
    return {
      id: workspace.id,
      title: workspace.title,
      activePaneId: workspace.activePaneId,
      paneCount: workspace.paneOrder.length
    };
  }

  private toWorkspaceContext(workspace: WorkspaceRecord): PaneWorkspaceContext {
    return {
      id: workspace.id,
      defaultBrowserPath: workspace.defaultBrowserPath,
      bus: workspace.bus
    };
  }

  private createPaneSnapshot(workspace: WorkspaceRecord, paneId: string, titleOverride?: string) {
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    const spec = this.options.paneRegistry.get(record.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${record.kind}'`);
    }
    return createPaneSnapshotHelper({
      spec,
      paneId,
      title: titleOverride ?? workspace.paneTitles.get(paneId) ?? humanizePaneKind(record.kind),
      active: workspace.activePaneId === paneId,
      record
    });
  }

  private seedWorkspace(workspace: WorkspaceRecord) {
    const kinds = [
      this.options.paneRegistry.get("cowsay") ? "cowsay" : null,
      "browser"
    ].filter((value): value is string => value !== null);

    workspace.paneOrder = [];
    workspace.paneTitles.clear();
    workspace.paneStates.clear();
    workspace.paneParams.clear();
    workspace.activePaneId = null;

    for (const kind of kinds) {
      const pane = this.addPane(workspace, {
        kind,
        title: kind === "browser" ? "Start" : humanizePaneKind(kind),
        ...(kind === "browser" ? { url: workspace.defaultBrowserPath } : {})
      });
      if (kind === "browser") {
        workspace.activePaneId = pane.id;
      }
    }
  }

  private createWorkspaceRecord(id: string, title: string) {
    const existing = this.workspaces.get(id);
    if (existing) {
      return existing;
    }

    const workspace: WorkspaceRecord = {
      id,
      title,
      defaultTitle: title,
      defaultBrowserPath: `/__flmux/internal/start?workspace=${encodeURIComponent(id)}`,
      bus: createWorkspaceBus(id),
      paneOrder: [],
      paneTitles: new Map(),
      paneStates: new Map(),
      paneParams: new Map(),
      activePaneId: null
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  private allocateWorkspaceDescriptor(inputTitle?: string) {
    let index = this.workspaces.size + 1;
    while (this.workspaces.has(`workspace.${index}`)) {
      index += 1;
    }

    return {
      id: `workspace.${index}`,
      title: inputTitle?.trim() || `Workspace ${index}`
    };
  }

  private addPane(workspace: WorkspaceRecord, input: NewPaneInput): ShellPaneRecordSnapshot {
    const paneId = `pane_${crypto.randomUUID()}`;
    const spec = this.options.paneRegistry.get(input.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${input.kind}'`);
    }
    const workspaceContext = this.toWorkspaceContext(workspace);
    const params = resolvePaneCreateParams({
      spec,
      workspace: workspaceContext,
      input,
      fallbackParams: cloneJsonObject(input.params)
    });
    const title = resolvePaneTitle({
      spec,
      workspace: workspaceContext,
      input,
      params,
      fallbackTitle: input.title?.trim() || humanizePaneKind(input.kind)
    });
    const record = createPaneStateRecord({
      spec,
      workspace: workspaceContext,
      params
    });
    const normalizedParams = cloneJsonObject(params) ?? {};
    if (isBrowserPaneStateRecord(record)) {
      const nextUrl = normalizeBrowserUrl("", this.appOrigin, record.url, workspace.defaultBrowserPath);
      record.url = nextUrl;
      normalizedParams.url = nextUrl;
    }
    if (isTerminalPaneStateRecord(record)) {
      normalizedParams.cwd = record.cwd;
    }

    workspace.paneOrder.push(paneId);
    workspace.paneTitles.set(paneId, title);
    workspace.paneStates.set(paneId, record);
    workspace.paneParams.set(paneId, Object.keys(normalizedParams).length > 0 ? normalizedParams : params);
    workspace.activePaneId = paneId;
    this.paneWorkspaceIds.set(paneId, workspace.id);

    return this.createPaneSnapshot(workspace, paneId, title);
  }
}

// ── Exported helpers ──

export function normalizeBrowserUrl(
  previousOrigin: string,
  nextOrigin: string,
  value: string,
  defaultBrowserPath: string
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return `${nextOrigin}${defaultBrowserPath}`;
  }

  if (previousOrigin && trimmed.startsWith(previousOrigin)) {
    return `${nextOrigin}${trimmed.slice(previousOrigin.length)}`;
  }

  if (trimmed.startsWith("/")) {
    return `${nextOrigin}${trimmed}`;
  }

  if (trimmed.includes("://")) {
    return trimmed;
  }

  return `${nextOrigin}${defaultBrowserPath}`;
}

function humanizePaneKind(kind: string): string {
  return kind
    .split(/[./_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Pane";
}

function cloneJsonObject(value: unknown) {
  return value && typeof value === "object"
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  return trimmed;
}
