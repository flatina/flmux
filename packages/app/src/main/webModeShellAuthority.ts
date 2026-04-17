import {
  PaneRegistry,
  createPaneSnapshot,
  createPaneStateRecord,
  createShellModel,
  createWorkspaceBus,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  resolvePaneCreateParams,
  resolvePaneTitle,
  type AppStatusSnapshot,
  type NewPaneInput,
  type PanePathMount,
  type PanePathMountContext,
  type PaneSpec,
  type PaneStateRecord,
  type PaneWorkspaceContext,
  type ShellModelAPI,
  type ShellModelHost,
  type ShellPaneRecordSnapshot,
  type ShellResolvedPanePathMount,
  type ShellResolvedPaneSubtreeMount,
  type ScopedPropertyTarget,
  type ShellTerminalDelegate,
  type WorkspaceBusEvent,
  type WorkspaceStatusSnapshot
} from "@flmux/core/shell";
import type {
  ExtensionDefinition,
  ExtensionManifestPane,
  ExtensionPaneDefinition
} from "@flmux/extension-api";
import { pathToFileURL } from "node:url";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { resolveTerminalCwdFromRoot } from "../shared/terminalPath";
import {
  adaptExtensionLifecycle,
  adaptExtensionPanePathMount,
  adaptExtensionPersistence
} from "../shared/extensionPaneAdapter";
import type { TerminalService } from "./terminal-service";
import { createServerShellModelRouter } from "./serverShellModelRouter";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { DiscoveredLocalExtension } from "./localExtensions";

type ExtensionModule = { default?: ExtensionDefinition };
export type ExtensionModuleImporter = (entryPath: string) => Promise<ExtensionModule>;

type WorkspaceRecord = {
  id: string;
  title: string;
  defaultTitle: string;
  defaultBrowserPath: string;
  bus: ReturnType<typeof createWorkspaceBus>;
  paneOrder: string[];
  paneTitles: Map<string, string>;
  paneStates: Map<string, PaneStateRecord>;
  paneParams: Map<string, Record<string, unknown> | undefined>;
  activePaneId: string | null;
};

export interface WebModeShellAuthority {
  readonly clientId: string;
  readonly shellModel: ShellModelAPI;
  readonly router: ReturnType<typeof createServerShellModelRouter>;
  start(origin: string): Promise<void>;
  applyTerminalEvent(event: TerminalRuntimeEvent): void;
}

export async function createWebModeShellAuthority(options: {
  projectDir: string;
  runtimeLabel: string;
  terminalService: TerminalService;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  extensionModuleImporter?: ExtensionModuleImporter;
}): Promise<WebModeShellAuthority> {
  const paneRegistry = new PaneRegistry<PaneSpec>();
  for (const spec of createBuiltinPaneSpecs(options.projectDir)) {
    paneRegistry.register(spec);
  }
  const extensionPaneSpecs = await createExtensionPaneSpecs(
    options.localExtensions ?? [],
    options.extensionModuleImporter ?? defaultImportExtensionModule
  );
  for (const spec of extensionPaneSpecs) {
    paneRegistry.register(spec);
  }

  const host = new HeadlessShellHost({
    projectDir: options.projectDir,
    runtimeLabel: options.runtimeLabel,
    paneRegistry,
    terminalService: options.terminalService
  });
  const shellModel = createShellModel({
    host,
    terminal: host.createTerminalDelegate()
  });
  const clientId = `server_${crypto.randomUUID()}`;

  return {
    clientId,
    shellModel,
    router: createServerShellModelRouter({
      authorityClientId: clientId,
      shellModel,
      getWorkspace: async () => host.getWorkspaceStatus(),
      clientRegistry: options.clientRegistry
    }),
    async start(origin: string) {
      host.setAppOrigin(origin);
      await host.initialize();
    },
    applyTerminalEvent(event) {
      host.applyTerminalEvent(event);
    }
  };
}

class HeadlessShellHost implements ShellModelHost {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly paneWorkspaceIds = new Map<string, string>();
  private appTitle = "flmux";
  private appOrigin = "http://127.0.0.1:0";
  private activeWorkspaceId: string | null = null;

  constructor(private readonly deps: {
    projectDir: string;
    runtimeLabel: string;
    paneRegistry: PaneRegistry<PaneSpec>;
    terminalService: TerminalService;
  }) {}

  async initialize() {
    if (this.activeWorkspaceId) {
      return;
    }

    const workspace = this.createWorkspaceRecord("workspace.1", "Workspace 1");
    this.activeWorkspaceId = workspace.id;
    this.seedWorkspace(workspace);
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
    return {
      attachRuntime: async (paneId, input) => {
        const { workspace, pane } = this.requireTerminalPane(paneId);
        if (pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' already has an attached runtime`);
        }

        const adopt = await this.deps.terminalService.adoptByPaneId({
          rootDir: this.deps.projectDir,
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

        const result = await this.deps.terminalService.create({
          paneId,
          rootDir: this.deps.projectDir,
          cwd: resolveTerminalCwdFromRoot(this.deps.projectDir, input.cwd ?? pane.cwd)
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

        const result = await this.deps.terminalService.write({
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

        const result = await this.deps.terminalService.resize({
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

        return await this.deps.terminalService.history({
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

        const result = await this.deps.terminalService.kill({
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

  async getAppStatus(): Promise<AppStatusSnapshot> {
    return {
      title: this.appTitle,
      origin: this.appOrigin,
      runtimeLabel: this.deps.runtimeLabel
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
    return this.deps.paneRegistry.get(kind) !== undefined;
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
      await this.deps.terminalService.kill({
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
    const workspace = this.requireWorkspaceForPane(paneId);
    const cloned = cloneJsonObject(nextParams) ?? {};
    const record = this.requirePaneRecord(workspace, paneId);
    if (isBrowserPaneStateRecord(record) && typeof cloned.url === "string") {
      const nextUrl = normalizeBrowserUrl("", this.appOrigin, cloned.url, workspace.defaultBrowserPath);
      record.url = nextUrl;
      workspace.paneParams.set(paneId, { ...cloned, url: nextUrl });
      return { ...cloned, url: nextUrl };
    }

    if (isTerminalPaneStateRecord(record) && typeof cloned.cwd === "string") {
      record.cwd = resolveTerminalCwdFromRoot(this.deps.projectDir, cloned.cwd);
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
    const workspace = this.requireWorkspaceForPane(paneId);
    const record = this.requirePaneRecord(workspace, paneId);
    const descriptor = this.requirePaneSpec(record.kind);
    return (descriptor.subtreeMounts ?? []).map((mount) => this.resolvePaneMount(workspace, paneId, record, mount));
  }

  async getPanePathMount(paneId: string): Promise<ShellResolvedPanePathMount | undefined> {
    const workspace = this.requireWorkspaceForPane(paneId);
    const record = this.requirePaneRecord(workspace, paneId);
    const descriptor = this.requirePaneSpec(record.kind);
    return descriptor.pathMount ? this.resolvePaneMount(workspace, paneId, record, descriptor.pathMount) : undefined;
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
      throw new Error("Web mode shell authority is not initialized");
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

  private requirePaneRecord(workspace: WorkspaceRecord, paneId: string) {
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    return record;
  }

  private findWorkspaceByPaneId(paneId: string) {
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    return workspaceId ? this.workspaces.get(workspaceId) ?? null : null;
  }

  private requireTerminalPane(paneId: string) {
    const workspace = this.requireWorkspaceForPane(paneId);
    const pane = this.requirePaneRecord(workspace, paneId);
    if (!isTerminalPaneStateRecord(pane)) {
      throw new Error(`Pane '${paneId}' is not a terminal pane`);
    }

    return { workspace, pane };
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
    const record = this.requirePaneRecord(workspace, paneId);
    const descriptor = this.requirePaneSpec(record.kind);
    return createPaneSnapshot({
      spec: descriptor,
      paneId,
      title: titleOverride ?? workspace.paneTitles.get(paneId) ?? humanizePaneKind(record.kind),
      active: workspace.activePaneId === paneId,
      record
    });
  }

  private requirePaneSpec(kind: string) {
    const descriptor = this.deps.paneRegistry.get(kind);
    if (!descriptor) {
      throw new Error(`Unknown pane kind '${kind}'`);
    }
    return descriptor;
  }

  private seedWorkspace(workspace: WorkspaceRecord) {
    const kinds = new Set([
      this.deps.paneRegistry.get("cowsay") ? "cowsay" : null,
      "browser"
    ].filter((value): value is string => value !== null));

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

  private addPane(workspace: WorkspaceRecord, input: NewPaneInput) {
    const paneId = `pane_${crypto.randomUUID()}`;
    const descriptor = this.requirePaneSpec(input.kind);
    const workspaceContext = this.toWorkspaceContext(workspace);
    const params = resolvePaneCreateParams({
      spec: descriptor,
      workspace: workspaceContext,
      input,
      fallbackParams: cloneJsonObject(input.params)
    });
    const title = resolvePaneTitle({
      spec: descriptor,
      workspace: workspaceContext,
      input,
      params,
      fallbackTitle: input.title?.trim() || humanizePaneKind(input.kind)
    });
    const record = createPaneStateRecord({
      spec: descriptor,
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

function createBuiltinPaneSpecs(projectDir: string): PaneSpec[] {
  return [
    {
      kind: "browser",
      lifecycle: {
        createParams: ({ workspace, input }) => ({
          url: normalizeBrowserUrl("", "", input.url ?? workspace.defaultBrowserPath, workspace.defaultBrowserPath)
        }),
        getTitle: ({ input, params }) =>
          input.title?.trim() || inferBrowserTitle(optionalStringParam(params?.url) ?? "Browser"),
        createRecord: ({ workspace, params }) => ({
          kind: "browser",
          url: normalizeBrowserUrl("", "", optionalStringParam(params?.url) ?? workspace.defaultBrowserPath, workspace.defaultBrowserPath)
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isBrowserPaneStateRecord(record)
            ? {
                id: paneId,
                kind: "browser",
                title,
                active,
                browser: {
                  url: record.url
                }
              }
            : {
                id: paneId,
                kind: record.kind,
                title,
                active
              }
      },
      subtreeMounts: [
        {
          mountKey: "browser",
          getStateSnapshot: ({ record }) =>
            isBrowserPaneStateRecord(record) ? { url: record.url } : undefined,
          canSetStatePath: ({ record }, relativePath) =>
            isBrowserPaneStateRecord(record) &&
            relativePath.length === 1 &&
            relativePath[0] === "url",
          setState: async ({ record, currentParams, setParams, workspace }, relativePath, value) => {
            if (!isBrowserPaneStateRecord(record)) {
              throw new Error("browser subtree only applies to browser panes");
            }
            if (relativePath.length !== 1 || relativePath[0] !== "url") {
              throw new Error(`Unsupported browser path '${relativePath.join("/")}'`);
            }

            const nextUrl = normalizeBrowserUrl("", "", requiredString(value, "Pane url"), workspace.defaultBrowserPath);
            record.url = nextUrl;
            await setParams({
              ...(currentParams ?? {}),
              url: nextUrl
            });
            return { value: nextUrl };
          },
          getStatusSnapshot: ({ record }) =>
            isBrowserPaneStateRecord(record) ? { url: record.url } : undefined
        }
      ]
    },
    {
      kind: "terminal",
      lifecycle: {
        createParams: ({ input }) => ({
          cwd: resolveTerminalCwdFromRoot(projectDir, input.cwd)
        }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ params }) => ({
          kind: "terminal",
          cwd: resolveTerminalCwdFromRoot(projectDir, optionalStringParam(params?.cwd)),
          rootKey: null,
          runtimeId: null,
          summary: null
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isTerminalPaneStateRecord(record)
            ? {
                id: paneId,
                kind: "terminal",
                title,
                active,
                terminal: {
                  attached: record.runtimeId !== null,
                  rootKey: record.rootKey,
                  cwd: record.cwd,
                  runtimeId: record.runtimeId,
                  alive: record.summary?.alive ?? null,
                  commandCount: record.summary?.commandCount ?? null,
                  createdAt: record.summary?.createdAt ?? null,
                  updatedAt: record.summary?.updatedAt ?? null
                }
              }
            : {
                id: paneId,
                kind: record.kind,
                title,
                active
              }
      },
      subtreeMounts: [
        {
          mountKey: "terminal",
          getStateSnapshot: ({ record }) =>
            isTerminalPaneStateRecord(record) ? { cwd: record.cwd } : undefined,
          getStatusSnapshot: ({ record }) =>
            isTerminalPaneStateRecord(record)
              ? {
                  attached: record.runtimeId !== null,
                  rootKey: record.rootKey,
                  cwd: record.cwd,
                  runtimeId: record.runtimeId,
                  alive: record.summary?.alive ?? null,
                  commandCount: record.summary?.commandCount ?? null,
                  createdAt: record.summary?.createdAt ?? null,
                  updatedAt: record.summary?.updatedAt ?? null
                }
              : undefined
        }
      ]
    }
  ];
}

async function createExtensionPaneSpecs(
  extensions: readonly DiscoveredLocalExtension[],
  importer: ExtensionModuleImporter
): Promise<PaneSpec[]> {
  const specs: PaneSpec[] = [];
  for (const extension of extensions) {
    const definitionByKind = await loadExtensionPaneDefinitions(extension, importer);
    for (const manifestPane of extension.runtimeManifest.panes ?? []) {
      specs.push(createExtensionPaneSpec(manifestPane, definitionByKind.get(manifestPane.kind)));
    }
  }
  return specs;
}

async function loadExtensionPaneDefinitions(
  extension: DiscoveredLocalExtension,
  importer: ExtensionModuleImporter
): Promise<Map<string, ExtensionPaneDefinition>> {
  const byKind = new Map<string, ExtensionPaneDefinition>();
  const entryPath = extension.rendererEntryPath;
  if (!entryPath) {
    return byKind;
  }
  try {
    const module = await importer(entryPath);
    for (const pane of module.default?.panes ?? []) {
      byKind.set(pane.kind, pane);
    }
  } catch (error) {
    console.warn(
      `[flmux] failed to load extension '${extension.id}' for server authority — pathMount / lifecycle hooks unavailable`,
      error
    );
  }
  return byKind;
}

function createExtensionPaneSpec(
  manifestPane: ExtensionManifestPane,
  definition: ExtensionPaneDefinition | undefined
): PaneSpec {
  const defaultTitle = manifestPane.defaultTitle;

  if (!definition) {
    if (!defaultTitle) {
      return { kind: manifestPane.kind };
    }
    return {
      kind: manifestPane.kind,
      lifecycle: {
        getTitle: ({ input }) => input.title?.trim() || defaultTitle
      }
    };
  }

  const lifecycle = adaptExtensionLifecycle(definition);
  const hasFallbackTitle = Boolean(defaultTitle);
  const mergedLifecycle = hasFallbackTitle && !lifecycle?.getTitle
    ? {
        ...(lifecycle ?? {}),
        getTitle: ({ input }: { input: NewPaneInput }) => input.title?.trim() || defaultTitle!
      }
    : lifecycle;

  return {
    kind: manifestPane.kind,
    lifecycle: mergedLifecycle,
    persistence: adaptExtensionPersistence(definition),
    pathMount: definition.pathMount ? adaptExtensionPanePathMount(definition.pathMount) : undefined
  };
}

async function defaultImportExtensionModule(entryPath: string): Promise<ExtensionModule> {
  const fileUrl = pathToFileURL(entryPath).href;
  return await import(fileUrl);
}

function humanizePaneKind(kind: string) {
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

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function inferBrowserTitle(url: string) {
  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop();
    return lastPath ? lastPath.charAt(0).toUpperCase() + lastPath.slice(1) : parsed.host || "Browser";
  } catch {
    return "Browser";
  }
}

function normalizeBrowserUrl(previousOrigin: string, nextOrigin: string, value: string, defaultBrowserPath: string) {
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
