import type {
  ExtensionPaneContext,
  ExtensionPaneDefinition,
  ExtensionPaneInstance,
  ExtensionPanePathMount,
  PaneStateStore,
  WorkspaceBusEvent
} from "@flmux/extension-api";
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

export function createExternalPaneDescriptor(options: ExtensionPaneDefinition): PaneDescriptor {
  const pathMount = options.pathMount ? createExternalPanePathMount(options.pathMount) : undefined;
  return {
    kind: options.kind,
    createRenderer(args) {
      const state = createExternalPaneState();
      return wrapExternalPaneRenderer(options, args, state);
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

function createExternalPanePathMount(options: ExtensionPanePathMount): PanePathMount {
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
}, state: PaneStateStore): ExtensionPaneContext {
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
        const event: WorkspaceBusEvent = {
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

function createExternalPaneState(): PaneStateStore {
  return new ExternalPaneStateController();
}

function wrapExternalPaneRenderer(
  definition: ExtensionPaneDefinition,
  args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  },
  state: PaneStateStore
): IContentRenderer {
  const host = createPaneHostElement();
  let instance: void | ExtensionPaneInstance;

  return {
    element: host,
    init(params: GroupPanelPartInitParameters) {
      synchronizeExternalPaneState(state, params.api, params.params);
      instance = definition.mount(host, createExternalPaneContext(args, state));
    },
    update(event: PanelUpdateEvent<Record<string, unknown>>) {
      synchronizeExternalPaneState(state, null, event.params);
      instance?.update?.(event.params);
    },
    layout(width, height) {
      instance?.layout?.(width, height);
    },
    toJSON() {
      return instance?.toJSON?.() ?? {};
    },
    focus() {
      instance?.focus?.();
    },
    dispose() {
      try {
        instance?.dispose?.();
      } finally {
        disposeExternalPaneState(state);
      }
    }
  };
}

function createPaneHostElement(): HTMLElement {
  if (typeof document !== "undefined") {
    return document.createElement("div");
  }

  return {
    className: "",
    innerHTML: "",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    replaceChildren() {}
  } as unknown as HTMLElement;
}

function synchronizeExternalPaneState(
  state: PaneStateStore,
  panelApi: GroupPanelPartInitParameters["api"] | null,
  nextParams: Record<string, unknown>
) {
  if (!(state instanceof ExternalPaneStateController)) {
    throw new Error("Unsupported external pane state implementation");
  }

  state.synchronize(panelApi, nextParams);
}

function disposeExternalPaneState(state: PaneStateStore) {
  if (!(state instanceof ExternalPaneStateController)) {
    throw new Error("Unsupported external pane state implementation");
  }

  state.dispose();
}

function cloneParams(value: Record<string, unknown> | undefined) {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {};
}

class ExternalPaneStateController implements PaneStateStore {
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
