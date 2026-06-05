import type {
  ExtensionPaneContext,
  ExtensionPaneInstance,
  ExtensionPaneRenderer,
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
import { setPaneHeaderMenu } from "./paneTabMenuRegistry";

// Renderer-side pane descriptor — only `kind` + `createRenderer`. The
// host owns lifecycle / pathMount / persistence via the server entry's
// `ExtensionPaneSpec`; renderer never sees them.
export function createExternalPaneDescriptor(extensionId: string, renderer: ExtensionPaneRenderer): PaneDescriptor {
  return {
    kind: renderer.kind,
    createRenderer(args) {
      const state = new ExternalPaneStateController(args.options.id, args.runtime.shellModel);
      return wrapExternalPaneRenderer(extensionId, renderer, args, state);
    }
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
    // Facade — never expose the host store directly. `dispose()` lives on it
    // and an `as any` cast would otherwise let an extension tear down the
    // shared store for every pane in the workspace.
    workspaceStatus: {
      get: (key) => args.runtime.workspaceStatus.get(key),
      set: (key, value) => args.runtime.workspaceStatus.set(key, value),
      subscribe: (key, handler) => {
        const unsubscribe = args.runtime.workspaceStatus.subscribe(key, handler);
        if (state instanceof ExternalPaneStateController) {
          state.trackCleanup(unsubscribe);
        }
        return unsubscribe;
      }
    },
    state,
    setHeaderMenu: (menu) => setPaneHeaderMenu(paneId, menu)
  };
}

function wrapExternalPaneRenderer(
  extensionId: string,
  renderer: ExtensionPaneRenderer,
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
      // A throwing extension mount must stay contained to this pane — it runs
      // inside dockview's layout restore, so an uncaught throw aborts the whole
      // workbench bootstrap (main.ts renders the error as a blank fatal page).
      // Render an in-pane error instead; the rest of the workbench is unaffected.
      try {
        synchronizeExternalPaneState(state, params.api, params.params);
        instance = renderer.mount(host, createExternalPaneContext(args, state));
      } catch (error) {
        console.error(`[flmux] extension pane '${extensionId}' failed to mount`, error);
        renderPaneMountError(host, extensionId, error);
      }
    },
    update(event: PanelUpdateEvent<Record<string, unknown>>) {
      try {
        synchronizeExternalPaneState(state, null, event.params);
        instance?.update?.(event.params);
      } catch (error) {
        console.error(`[flmux] extension pane '${extensionId}' update failed`, error);
      }
    },
    layout(width, height) {
      try {
        instance?.layout?.(width, height);
      } catch (error) {
        console.error(`[flmux] extension pane '${extensionId}' layout failed`, error);
      }
    },
    toJSON() {
      return instance?.toJSON?.() ?? {};
    },
    focus() {
      try {
        instance?.focus?.();
      } catch (error) {
        console.error(`[flmux] extension pane '${extensionId}' focus failed`, error);
      }
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

/** In-pane fallback when an extension's mount throws — keeps the failure local
 * (the pane shows the error) instead of bubbling up and blanking the workbench. */
function renderPaneMountError(host: HTMLElement, extensionId: string, error: unknown): void {
  if (typeof document === "undefined") return;
  host.replaceChildren();
  const box = document.createElement("div");
  box.className = "flmux-ext-pane-error";
  const title = document.createElement("div");
  title.className = "flmux-ext-pane-error__title";
  title.textContent = `This pane failed to load — ${extensionId}`;
  const detail = document.createElement("div");
  detail.textContent = error instanceof Error ? error.message : String(error);
  box.append(title, detail);
  host.append(box);
}

function createPaneHostElement(): HTMLElement {
  if (typeof document !== "undefined") {
    const host = document.createElement("div");
    // Default pane-occupation policy: extensions fill the pane area unless
    // they opt out with their own CSS. `.flmux-ext-pane` is defined in
    // `styles.css` — extensions that set additional classes should use
    // `classList.add(...)` so the base class is preserved.
    host.classList.add("flmux-ext-pane");
    return host;
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
    replaceChildren() {},
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      }
    }
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
