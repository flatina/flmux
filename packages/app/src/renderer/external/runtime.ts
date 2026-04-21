import type {
  ExtensionPaneContext,
  ExtensionPaneDefinition,
  ExtensionPaneInstance,
  PaneStateStore,
  WorkspaceBusEvent
} from "@flmux/extension-api";
import type {
  CreateComponentOptions,
  GroupPanelPartInitParameters,
  IContentRenderer,
  PanelUpdateEvent
} from "dockview-core";
import type { PaneDescriptor, PaneRendererRuntimeContext, PaneWorkspaceContext } from "../shell/paneRegistry";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import {
  adaptExtensionLifecycle,
  adaptExtensionPanePathMount,
  adaptExtensionPersistence
} from "../../shared/extensionPaneAdapter";

export function createExternalPaneDescriptor(options: ExtensionPaneDefinition): PaneDescriptor {
  return {
    kind: options.kind,
    createRenderer(args) {
      const state = new ExternalPaneStateController(args.options.id, args.runtime.shellModel);
      return wrapExternalPaneRenderer(options, args, state);
    },
    lifecycle: adaptExtensionLifecycle(options),
    persistence: adaptExtensionPersistence(options),
    pathMount: options.pathMount ? adaptExtensionPanePathMount(options.pathMount) : undefined
  };
}

function createExternalPaneContext(
  args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  },
  state: PaneStateStore
): ExtensionPaneContext {
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
  return value ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>) : {};
}

class ExternalPaneStateController implements PaneStateStore {
  private params: Record<string, unknown> = {};
  private panelApi: GroupPanelPartInitParameters["api"] | null = null;
  private readonly cleanups = new Set<() => void>();

  constructor(
    private readonly paneId: string,
    private readonly shellModel: ShellModelAPI
  ) {}

  getParams<T extends Record<string, unknown> = Record<string, unknown>>() {
    return cloneParams(this.params) as T;
  }

  setParams(nextParams: Record<string, unknown>) {
    this.params = cloneParams(nextParams);
    this.panelApi?.updateParameters(this.params);
  }

  patchParams(nextParams: Record<string, unknown>) {
    const patch = cloneParams(nextParams);
    this.params = { ...this.params, ...patch };
    this.panelApi?.updateParameters(this.params);
    void this.shellModel.pathCall(`/panes/${this.paneId}/params:patch`, patch).catch((error) => {
      console.warn(`failed to patch params for pane '${this.paneId}'`, error);
    });
  }

  getTitle() {
    return this.panelApi?.title;
  }

  setTitle(title: string) {
    void this.shellModel.pathSet(`/panes/${this.paneId}/title`, title).catch((error) => {
      console.warn(`failed to set title for pane '${this.paneId}'`, error);
    });
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
