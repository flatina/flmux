import type {
  CreateComponentOptions,
  GroupPanelPartInitParameters,
  IContentRenderer,
  PanelUpdateEvent
} from "dockview-core";
import type {
  PaneDescriptor,
  PanePathMount,
  PaneRendererRuntimeContext,
  PaneWorkspaceContext
} from "../shell/paneRegistry";
import type {
  NewPaneInput,
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult,
  WorkspaceBusEvent
} from "../shell/types";

export type ExternalPathGetResult = PathGetResult;
export type ExternalPathListResult = PathListResult;
export type ExternalPathSetResult = PathSetResult;
export type ExternalPathCallResult = PathCallResult;
export type ExternalWorkspaceBusEvent<T = unknown> = WorkspaceBusEvent<T>;

export interface ExternalPaneShell {
  get(path: string): Promise<ExternalPathGetResult>;
  list(path: string): Promise<ExternalPathListResult>;
  set(path: string, value: unknown): Promise<ExternalPathSetResult>;
  call(path: string, args?: Record<string, unknown>): Promise<ExternalPathCallResult>;
}

export interface ExternalPaneBus {
  publish(topic: string, payload?: unknown): Promise<ExternalPathCallResult>;
  subscribe<T = unknown>(topic: string, handler: (event: ExternalWorkspaceBusEvent<T>) => void): () => void;
}

export interface ExternalPaneContext {
  paneId: string;
  workspaceId: string;
  shell: ExternalPaneShell;
  bus: ExternalPaneBus;
  state: ExternalPaneState;
}

export interface ExternalPaneState {
  getParams<T extends Record<string, unknown> = Record<string, unknown>>(): T;
  setParams(nextParams: Record<string, unknown>): void;
  patchParams(nextParams: Record<string, unknown>): void;
  getTitle(): string | undefined;
  setTitle(title: string): void;
}

export interface ExternalPaneDescriptorOptions {
  kind: string;
  createRenderer(context: ExternalPaneContext): IContentRenderer;
  createParams?(args: {
    workspaceId: string;
    rootDir: string;
    defaultFixture: string;
    input: NewPaneInput;
  }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspaceId: string;
    rootDir: string;
    defaultFixture: string;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  normalizeRestoredParams?(args: {
    workspaceId: string;
    rootDir: string;
    defaultFixture: string;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspaceId: string;
    rootDir: string;
    defaultFixture: string;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  pathMount?: ExternalPanePathMountOptions;
}

export interface ExternalPanePathMountSnapshotArgs {
  paneId: string;
  workspaceId: string;
  rootDir: string;
  defaultFixture: string;
  currentParams: Record<string, unknown> | undefined;
}

export interface ExternalPanePathMountSetArgs extends ExternalPanePathMountSnapshotArgs {
  relativePath: string[];
  value: unknown;
  setParams(nextParams: Record<string, unknown>): Promise<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ExternalPanePathMountWritableArgs extends ExternalPanePathMountSnapshotArgs {
  relativePath: string[];
}

export interface ExternalPanePathMountOptions {
  mountKey: string;
  getStateSnapshot?(args: ExternalPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
  canSetStatePath?(args: ExternalPanePathMountWritableArgs): boolean;
  setState?(args: ExternalPanePathMountSetArgs): Promise<{ value: unknown }> | { value: unknown };
  getStatusSnapshot?(args: ExternalPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
}

export function createExternalPaneDescriptor(options: ExternalPaneDescriptorOptions): PaneDescriptor {
  const pathMount = options.pathMount ? createExternalPanePathMount(options.pathMount) : undefined;
  return {
    kind: options.kind,
    createRenderer(args) {
      const state = createExternalPaneState();
      const renderer = options.createRenderer(createExternalPaneContext(args, state));
      return wrapExternalPaneRenderer(renderer, state);
    },
    lifecycle:
      options.createParams || options.getTitle
        ? {
            createParams: options.createParams
              ? ({ workspace, input }) =>
                  options.createParams!({
                    workspaceId: workspace.id,
                    rootDir: workspace.rootDir,
                    defaultFixture: workspace.defaultFixture,
                    input
                  })
              : undefined,
            getTitle: options.getTitle
              ? ({ workspace, input, params }) =>
                  options.getTitle!({
                    workspaceId: workspace.id,
                    rootDir: workspace.rootDir,
                    defaultFixture: workspace.defaultFixture,
                    input,
                    params
                  })
              : undefined
          }
        : undefined,
    persistence:
      options.normalizeRestoredParams || options.serializeParams
        ? {
            normalizeRestoredParams: options.normalizeRestoredParams
              ? ({ workspace, params }) =>
                  options.normalizeRestoredParams!({
                    workspaceId: workspace.id,
                    rootDir: workspace.rootDir,
                    defaultFixture: workspace.defaultFixture,
                    params
                  })
              : undefined,
            serializeParams: options.serializeParams
              ? ({ workspace, currentParams }) =>
                  options.serializeParams!({
                    workspaceId: workspace.id,
                    rootDir: workspace.rootDir,
                    defaultFixture: workspace.defaultFixture,
                    currentParams
                  })
              : undefined
          }
        : undefined,
    pathMount
  };
}

function createExternalPanePathMount(options: ExternalPanePathMountOptions): PanePathMount {
  return {
    mountKey: options.mountKey,
    getStateSnapshot: options.getStateSnapshot
      ? ({ paneId, workspace, currentParams }) =>
          options.getStateSnapshot!({
            paneId,
            workspaceId: workspace.id,
            rootDir: workspace.rootDir,
            defaultFixture: workspace.defaultFixture,
            currentParams
          })
      : undefined,
    canSetStatePath: options.canSetStatePath
      ? ({ paneId, workspace, currentParams }, relativePath) =>
          options.canSetStatePath!({
            paneId,
            workspaceId: workspace.id,
            rootDir: workspace.rootDir,
            defaultFixture: workspace.defaultFixture,
            currentParams,
            relativePath
          })
      : undefined,
    setState: options.setState
      ? ({ paneId, workspace, currentParams, setParams, patchParams }, relativePath, value) =>
          options.setState!({
            paneId,
            workspaceId: workspace.id,
            rootDir: workspace.rootDir,
            defaultFixture: workspace.defaultFixture,
            currentParams,
            relativePath,
            value,
            setParams: async (nextParams) => await setParams(nextParams),
            patchParams: async (patch) => await patchParams(patch)
          })
      : undefined,
    getStatusSnapshot: options.getStatusSnapshot
      ? ({ paneId, workspace, currentParams }) =>
          options.getStatusSnapshot!({
            paneId,
            workspaceId: workspace.id,
            rootDir: workspace.rootDir,
            defaultFixture: workspace.defaultFixture,
            currentParams
          })
      : undefined
  };
}

function createExternalPaneContext(args: {
  workspace: PaneWorkspaceContext;
  options: CreateComponentOptions;
  runtime: PaneRendererRuntimeContext;
}, state: ExternalPaneState): ExternalPaneContext {
  const paneId = args.options.id;

  return {
    paneId,
    workspaceId: args.workspace.id,
    shell: {
      get: (path) => args.runtime.shellModel.pathGet(path),
      list: (path) => args.runtime.shellModel.pathList(path),
      set: (path, value) => args.runtime.shellModel.pathSet(path, value),
      call: (path, shellArgs) => args.runtime.shellModel.pathCall(path, shellArgs, { sourcePaneId: paneId })
    },
    bus: {
      publish: (topic, payload) => {
        const event: ExternalWorkspaceBusEvent = {
          topic,
          sourcePaneId: paneId,
          payload: payload ?? null,
          workspaceId: args.workspace.id,
          timestamp: Date.now()
        };
        args.workspace.bus.publish(event);
        return Promise.resolve({ ok: true as const, value: { ok: true, published: event } });
      },
      subscribe: (topic, handler) => {
        const unsubscribe = args.workspace.bus.subscribe(topic, handler);
        if (state instanceof ExternalPaneStateController) {
          state.trackCleanup(unsubscribe);
        }

        return unsubscribe;
      }
    },
    state
  };
}

function createExternalPaneState(): ExternalPaneState {
  return new ExternalPaneStateController();
}

function wrapExternalPaneRenderer(renderer: IContentRenderer, state: ExternalPaneState): IContentRenderer {
  return {
    element: renderer.element,
    init(params: GroupPanelPartInitParameters) {
      synchronizeExternalPaneState(state, params.api, params.params);
      renderer.init?.(params);
    },
    update(event: PanelUpdateEvent<Record<string, unknown>>) {
      synchronizeExternalPaneState(state, null, event.params);
      renderer.update?.(event);
    },
    layout(width, height) {
      renderer.layout?.(width, height);
    },
    toJSON() {
      return renderer.toJSON?.() ?? {};
    },
    focus() {
      renderer.focus?.();
    },
    dispose() {
      try {
        renderer.dispose?.();
      } finally {
        disposeExternalPaneState(state);
      }
    }
  };
}

function synchronizeExternalPaneState(
  state: ExternalPaneState,
  panelApi: GroupPanelPartInitParameters["api"] | null,
  nextParams: Record<string, unknown>
) {
  if (!(state instanceof ExternalPaneStateController)) {
    throw new Error("Unsupported external pane state implementation");
  }

  state.synchronize(panelApi, nextParams);
}

function disposeExternalPaneState(state: ExternalPaneState) {
  if (!(state instanceof ExternalPaneStateController)) {
    throw new Error("Unsupported external pane state implementation");
  }

  state.dispose();
}

function cloneParams(value: Record<string, unknown> | undefined) {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {};
}

class ExternalPaneStateController implements ExternalPaneState {
  private params: Record<string, unknown> = {};
  private panelApi: GroupPanelPartInitParameters["api"] | null = null;
  private readonly cleanups = new Set<() => void>();

  getParams<T extends Record<string, unknown> = Record<string, unknown>>() {
    return cloneParams(this.params) as T;
  }

  setParams(nextParams: Record<string, unknown>) {
    this.params = cloneParams(nextParams);
    this.panelApi?.updateParameters(this.params);
  }

  patchParams(nextParams: Record<string, unknown>) {
    this.params = {
      ...this.params,
      ...cloneParams(nextParams)
    };
    this.panelApi?.updateParameters(this.params);
  }

  getTitle() {
    return this.panelApi?.title;
  }

  setTitle(title: string) {
    this.panelApi?.setTitle(title);
  }

  synchronize(panelApi: GroupPanelPartInitParameters["api"] | null, nextParams: Record<string, unknown>) {
    if (panelApi) {
      this.panelApi = panelApi;
    }

    this.params = cloneParams(nextParams);
  }

  trackCleanup(cleanup: () => void) {
    this.cleanups.add(cleanup);
  }

  dispose() {
    for (const cleanup of this.cleanups) {
      cleanup();
    }

    this.cleanups.clear();
    this.panelApi = null;
  }
}
