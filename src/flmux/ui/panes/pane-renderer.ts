import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  IDockviewPanelProps,
  PanelUpdateEvent
} from "dockview-core";
import type {
  AppProps,
  FlmuxView,
  FlmuxViewInstance,
  HeaderAction,
  PaneProps,
  ResolvedTheme,
  App,
  Pane,
  Workspace,
  WorkspaceProps
} from "../../../types/view";
import type { PaneOpenOptions } from "../../../types/setup";
import type { PropertyHandle, PropertyInfo } from "../../../types/property";
import { parseViewKey } from "../../../lib/view-key";
import { asPaneId, type PaneId, type TabId } from "../../../lib/ids";
import type {
  BrowserPaneParams,
  EditorPaneParams,
  ExplorerPaneParams,
  PaneParams,
  TerminalPaneParams,
  ViewPaneParams
} from "../../model/pane-params";
import type { ScopeProperty } from "../../props/property";
import { getHostRpc } from "../../renderer/transport/host-rpc";
import type { PaneCreateDirection, PaneCreateInput, PaneResult } from "../../../types/pane";
import { loadExtensionModule } from "../ext/module-loader";
import { buildNote } from "../helpers";
import { getResolvedTheme, onThemeChange } from "../theme";
import { terminalView } from "./terminal-pane";

const hostRpc = getHostRpc();

type PropertyScopeOwner = {
  properties: Record<string, ScopeProperty>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => unknown;
  values: () => Record<string, unknown>;
  schema: () => Record<string, PropertyInfo>;
  emit: (eventType: string, ...args: unknown[]) => void;
  on: (eventType: string, handler: (...args: unknown[]) => void) => () => void;
};

type PaneScopeOwner = PropertyScopeOwner & {
  setState: (nextState: Record<string, unknown>) => void;
  markActivated?: () => void;
};

export type PaneRendererContext = {
  workspaceRoot: string;
  webPort: number | null;
  getTabId: () => TabId;
  openPane: (
    leaf: PaneCreateInput,
    placement?: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
    options?: PaneOpenOptions
  ) => Promise<PaneResult>;
  onPaneRemoved?: (paneId: PaneId, tabId: TabId) => void;
  getAppSummary: () => import("../../../types/view").AppSummaryBase & { panes: import("../../../types/view").PaneSummaryBase[] };
  listTabs: () => import("../../../types/view").WorkspaceSummaryBase[];
  getAppScope: () => PropertyScopeOwner;
  getWorkspaceScope: (tabId: TabId) => PropertyScopeOwner | null;
  getPaneScope: (paneId: PaneId) => PaneScopeOwner | null;
  onPaneReady?: (paneId: PaneId, tabId: TabId) => void;
  registerPreCloseHook: (paneId: PaneId, hook: () => void) => void;
  unregisterPreCloseHook: (paneId: PaneId) => void;
  firePreCloseHook: (paneId: PaneId) => void;
  subscribeOuterVisibility?: (callback: (visible: boolean) => void) => () => void;
  onHeaderActionsChanged?: (paneId: PaneId, actions: HeaderAction[]) => void;
};

export class PaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private props: IDockviewPanelProps<PaneParams> | null = null;
  private viewPaneId: string | null = null;
  private viewKey: string | null = null;
  private viewInstance: FlmuxViewInstance | null = null;
  private viewMounting = false;
  private viewParams: unknown = undefined;
  private viewState: unknown = undefined;
  private activeMountToken: symbol | null = null;
  private viewDisposables: Array<() => void> = [];

  constructor(private readonly context: PaneRendererContext) {
    this.element.className = "pane-shell";
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.props = parameters as unknown as IDockviewPanelProps<PaneParams>;
    const paneId = asPaneId(this.props.api.id);
    const tabId = this.context.getTabId();
    this.context.registerPreCloseHook(paneId, () => this.prepareForClose());
    this.context.onPaneReady?.(paneId, tabId);
    this.props.api.onDidActiveChange((event) => {
      if (event.isActive) {
        (this.context.getPaneScope(paneId) as PaneScopeOwner | null)?.markActivated?.();
      }
    });
    this.render();
  }

  update(event: PanelUpdateEvent<PaneParams>): void {
    if (!this.props) {
      return;
    }

    this.props = {
      ...this.props,
      params: {
        ...this.props.params,
        ...event.params
      } as PaneParams
    };

    this.render();
  }

  dispose(): void {
    this.disposeView();
    if (this.props) {
      this.context.unregisterPreCloseHook(asPaneId(this.props.api.id));
    }
    this.props = null;
    this.element.replaceChildren();
  }

  private prepareForClose(): void {
    this.disposeView();
    this.element.replaceChildren();
  }

  private render(): void {
    if (!this.props) {
      return;
    }

    const params = this.props.params;
    if (params.kind === "terminal") {
      this.renderTerminal(params);
      return;
    }

    if (params.kind === "browser") {
      this.renderBrowser(params);
      return;
    }

    if (params.kind === "editor") {
      this.renderEditor(params);
      return;
    }

    if (params.kind === "explorer") {
      this.renderExplorer(params);
      return;
    }

    if (params.kind === "view") {
      this.renderView(params);
      return;
    }

    this.disposeView();
    this.element.replaceChildren(buildNote(`Unknown pane kind: ${(params as PaneParams).kind}`));
  }

  private renderTerminal(params: TerminalPaneParams): void {
    this.renderBuiltInView("core:terminal", omitPaneState(params), params.state, terminalView);
  }

  private renderBrowser(params: BrowserPaneParams): void {
    this.renderViewByKey("browser:browser", omitPaneState(params), params.state);
  }

  private renderEditor(params: EditorPaneParams): void {
    this.renderViewByKey("code-editor:editor", omitPaneState(params), params.state);
  }

  private renderExplorer(params: ExplorerPaneParams): void {
    this.renderViewByKey("dir-tree:explorer", omitPaneState(params), params.state);
  }

  private renderView(params: ViewPaneParams): void {
    if (!parseViewKey(params.viewKey)) {
      this.disposeView();
      this.element.replaceChildren(buildNote(`Invalid view key: ${params.viewKey}`));
      return;
    }

    this.renderViewByKey(params.viewKey, {}, params.state);
  }

  private renderViewByKey(viewKey: string, params: unknown, state: unknown): void {
    if (!this.props) {
      return;
    }

    if (this.viewPaneId === this.props.api.id && this.viewKey === viewKey && (this.viewInstance || this.viewMounting)) {
      const paramsChanged = !isShallowEqual(this.viewParams, params);
      this.viewParams = params;
      this.viewState = state;
      if (paramsChanged && this.viewInstance) {
        void this.viewInstance.update?.(params as never);
      }
      return;
    }

    this.disposeView();
    void this.mountExtensionView({ viewKey, params, state });
  }

  private renderBuiltInView(viewKey: string, params: unknown, state: unknown, view: FlmuxView<any, any>): void {
    if (!this.props) {
      return;
    }

    if (this.viewPaneId === this.props.api.id && this.viewKey === viewKey && (this.viewInstance || this.viewMounting)) {
      const paramsChanged = !isShallowEqual(this.viewParams, params);
      this.viewParams = params;
      this.viewState = state;
      if (paramsChanged && this.viewInstance) {
        void this.viewInstance.update?.(params as never);
      }
      return;
    }

    this.disposeView();
    void this.mountBuiltInView({ viewKey, params, state, view });
  }

  private async mountExtensionView(params: { viewKey: string; params: unknown; state: unknown }): Promise<void> {
    if (!this.props) {
      return;
    }

    const parsed = parseViewKey(params.viewKey);
    if (!parsed) {
      this.element.replaceChildren(buildNote(`Invalid view key: ${params.viewKey}`));
      return;
    }

    const paneId = asPaneId(this.props.api.id);
    this.viewPaneId = this.props.api.id;
    this.viewKey = params.viewKey;
    this.viewParams = params.params;
    this.viewState = params.state;

    try {
      this.viewMounting = true;
      const mod = await loadExtensionModule<Record<string, unknown>>(
        `view:${parsed.extensionId}`,
        `flmux-ext://${parsed.extensionId}/index.js`,
        async () => {
          const loadResult = await hostRpc.request("extension.textLoad", {
            extensionId: parsed.extensionId,
            kind: "renderer"
          });
          if (!loadResult.ok) {
            throw new Error(loadResult.error);
          }
          return loadResult.content;
        }
      );

      const view = resolveViewExport(mod);
      if (!view) {
        this.element.replaceChildren(buildNote(`Extension ${parsed.extensionId} has no view export`));
        return;
      }

      const tabId = this.context.getTabId();
      await this.mountViewInstance(view, params.viewKey, paneId, tabId, `Extension ${parsed.extensionId}`);
    } catch (err) {
      this.viewInstance = null;
      const message = err instanceof Error ? err.message : String(err);
      this.element.replaceChildren(buildNote(`Extension ${parsed.extensionId} mount error: ${message}`));
    } finally {
      this.viewMounting = false;
    }
  }

  private async mountBuiltInView(params: {
    viewKey: string;
    params: unknown;
    state: unknown;
    view: FlmuxView<any, any>;
  }): Promise<void> {
    if (!this.props) {
      return;
    }

    const paneId = asPaneId(this.props.api.id);
    const tabId = this.context.getTabId();
    this.viewPaneId = this.props.api.id;
    this.viewKey = params.viewKey;
    this.viewParams = params.params;
    this.viewState = params.state;

    const host = document.createElement("div");
    host.className = "extension-host";
    host.style.cssText = "width:100%;height:100%;overflow:auto;";

    try {
      this.viewMounting = true;
      // Yield to the microtask queue so that Dockview's addPanel finishes
      // registering the panel in the group before the view instance runs.
      // Without this, setPaneProp/findWorkspacePane can't find the panel
      // because it's called from inside createPanel (before openPanel).
      await Promise.resolve();
      await this.mountViewInstance(params.view, params.viewKey, paneId, tabId, "Built-in pane", host);
    } catch (err) {
      this.viewInstance = null;
      const message = err instanceof Error ? err.message : String(err);
      this.element.replaceChildren(buildNote(`Built-in pane mount error: ${message}`));
    } finally {
      this.viewMounting = false;
    }
  }

  private disposeView(): void {
    for (const dispose of this.viewDisposables) {
      dispose();
    }
    this.viewDisposables = [];

    this.activeMountToken = null;

    if (this.viewInstance) {
      try {
        this.viewInstance.dispose?.();
      } catch {
        // best effort
      }
      this.viewInstance = null;
    }

    this.viewPaneId = null;
    this.viewKey = null;
    this.viewMounting = false;
    this.viewParams = undefined;
    this.viewState = undefined;
  }

  private async mountViewInstance(
    view: FlmuxView<any, any>,
    viewKey: string,
    paneId: PaneId,
    tabId: TabId,
    errorPrefix: string,
    host = createExtensionHost()
  ): Promise<void> {
    const mountToken = Symbol(`${viewKey}:${paneId}`);
    this.activeMountToken = mountToken;
    const instance = await view.createInstance(this.buildViewContext(viewKey, paneId, tabId) as any);
    let hostInserted = false;
    try {
      if (!this.isMountStillActive(mountToken, paneId, viewKey)) {
        try {
          instance.dispose?.();
        } catch {
          // best effort cleanup
        }
        return;
      }
      await instance.beforeMount?.(host);
      if (!this.isMountStillActive(mountToken, paneId, viewKey)) {
        try {
          instance.dispose?.();
        } catch {
          // best effort cleanup
        }
        return;
      }
      this.element.replaceChildren(host);
      hostInserted = true;
      await instance.mount(host);
      if (!this.isMountStillActive(mountToken, paneId, viewKey)) {
        try {
          instance.dispose?.();
        } catch {
          // best effort cleanup
        }
        if (hostInserted) {
          host.replaceChildren();
        }
        return;
      }
      this.viewInstance = instance;
    } catch (error) {
      try {
        instance.dispose?.();
      } catch {
        // best effort cleanup
      }
      const message = error instanceof Error ? error.message : String(error);
      this.viewInstance = null;
      this.element.replaceChildren(buildNote(`${errorPrefix} mount error: ${message}`));
      if (hostInserted) {
        host.replaceChildren();
      }
    }
  }

  private isMountStillActive(mountToken: symbol, paneId: PaneId, viewKey: string): boolean {
    return (
      this.activeMountToken === mountToken &&
      this.viewPaneId === String(paneId) &&
      this.viewKey === viewKey &&
      this.props?.api.id === String(paneId)
    );
  }

  private buildViewContext(viewKey: string, paneId: PaneId, tabId: TabId) {
    const parsed = parseViewKey(viewKey);
    if (!parsed) {
      throw new Error(`Invalid view key: ${viewKey}`);
    }

    const extensionId = parsed.extensionId;
    const buildPropertyHandle = (getOwner: () => PropertyScopeOwner | null): PropertyHandle => ({
      get: (key: string) => getOwner()?.get(key),
      list: () => getOwner()?.values() ?? {},
      schema: () => getOwner()?.schema() ?? {},
      set: (key: string, value: unknown) => {
        const owner = getOwner();
        if (!owner) throw new Error("Property owner not available");
        owner.set(key, value);
      }
    });
    const requireOwner = (owner: PropertyScopeOwner | null): PropertyScopeOwner => {
      if (!owner) throw new Error("Property owner not available");
      return owner;
    };
    const requireProperty = (owner: PropertyScopeOwner | null, key: string): ScopeProperty => {
      const property = requireOwner(owner).properties[key];
      if (!property) throw new Error(`Property not available: ${key}`);
      return property;
    };
    const requirePaneOwner = (owner: PaneScopeOwner | null): PaneScopeOwner => {
      if (!owner) throw new Error("Pane scope owner not available");
      return owner;
    };
    const track = (unsubscribe: () => void): (() => void) => {
      this.viewDisposables.push(unsubscribe);
      return () => {
        unsubscribe();
        this.viewDisposables = this.viewDisposables.filter((entry) => entry !== unsubscribe);
      };
    };
    const buildAppHandle = (): App => ({
      get title() {
        return requireProperty(thisContext.getAppScope(), "title").get() as AppProps["title"];
      },
      set title(value: AppProps["title"]) {
        requireOwner(thisContext.getAppScope()).set("title", value);
      },
      props: buildPropertyHandle(() => thisContext.getAppScope()),
      emit: (eventType: string, ...args: unknown[]) => thisContext.getAppScope().emit(eventType, ...args),
      on: (eventType: string, handler) => track(thisContext.getAppScope().on(eventType, handler))
    });
    const buildWorkspaceHandle = (targetTabId: TabId): Workspace => ({
      tabId: targetTabId,
      get title() {
        return requireProperty(
          thisContext.getWorkspaceScope(targetTabId),
          "title"
        ).get() as WorkspaceProps["title"];
      },
      set title(value: WorkspaceProps["title"]) {
        requireOwner(thisContext.getWorkspaceScope(targetTabId)).set("title", value);
      },
      props: buildPropertyHandle(() => thisContext.getWorkspaceScope(targetTabId)),
      emit: (eventType: string, ...args: unknown[]) =>
        thisContext.getWorkspaceScope(targetTabId)?.emit(eventType, ...args),
      on: (eventType: string, handler) => {
        const owner = thisContext.getWorkspaceScope(targetTabId);
        return owner ? track(owner.on(eventType, handler)) : () => {};
      }
    });
    const buildPaneHandle = (targetPaneId: PaneId): Pane => ({
      paneId: targetPaneId,
      get title() {
        return requireProperty(thisContext.getPaneScope(targetPaneId), "title").get() as PaneProps["title"];
      },
      set title(value: PaneProps["title"]) {
        requireOwner(thisContext.getPaneScope(targetPaneId)).set("title", value);
      },
      props: buildPropertyHandle(() => thisContext.getPaneScope(targetPaneId)),
      emit: (eventType: string, ...args: unknown[]) => thisContext.getPaneScope(targetPaneId)?.emit(eventType, ...args),
      on: (eventType: string, handler) => {
        const owner = thisContext.getPaneScope(targetPaneId);
        return owner ? track(owner.on(eventType, handler)) : () => {};
      }
    });
    const thisContext = this.context;
    return {
      viewKey,
      paneId,
      tabId,
      workspaceRoot: this.context.workspaceRoot,
      webPort: this.context.webPort,
      params: this.viewParams,
      state: this.viewState as Record<string, unknown> | undefined,
      loadAssetText: async (path: string) => {
        const result = await hostRpc.request("extension.textLoad", { extensionId, kind: "asset", path });
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.content;
      },
      fs: {
        readFile: async (path: string) => {
          const result = await hostRpc.request("fs.readFile", { path });
          if (!result.ok) throw new Error(result.error);
          return result.content;
        },
        writeFile: async (path: string, content: string) => {
          const result = await hostRpc.request("fs.writeFile", { path, content });
          if (!result.ok) throw new Error(result.error);
        },
        readDir: async (path: string) => {
          const result = await hostRpc.request("fs.readDir", { path });
          if (!result.ok) throw new Error(result.error);
          return result.entries;
        }
      },
      setState: (nextState: Record<string, unknown>) => {
        const mergedState = mergeState(this.viewState, nextState);
        this.viewState = mergedState;
        requirePaneOwner(this.context.getPaneScope(paneId)).setState(mergedState);
      },
      app: buildAppHandle(),
      curWorkspace: buildWorkspaceHandle(tabId),
      curPane: buildPaneHandle(paneId),
      getAppSummary: () => this.context.getAppSummary(),
      listTabs: () => this.context.listTabs(),
      getWorkspace: (targetTabId: TabId) => buildWorkspaceHandle(targetTabId),
      getPane: (targetPaneId: PaneId) => buildPaneHandle(targetPaneId),
      setHeaderActions: (actions: HeaderAction[]) => {
        this.context.onHeaderActionsChanged?.(paneId, actions);
      },
      closePane: () => {
        this.props?.api.close();
      },
      openPane: (
        leaf: PaneCreateInput,
        placement?: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
        options?: PaneOpenOptions
      ) =>
        this.context.openPane(
          leaf,
          {
            referencePaneId: placement?.referencePaneId ?? paneId,
            direction: placement?.direction
          },
          options
        ),
      onActiveChange: (handler: (isActive: boolean) => void) => {
        const disposable = this.props?.api.onDidActiveChange((event) => handler(event.isActive));
        return () => disposable?.dispose();
      },
      onVisibilityChange: (handler: (visible: boolean) => void) => {
        const propsDisposable = this.props?.api.onDidVisibilityChange((event) => handler(event.isVisible));
        const outerDisposable = this.context.subscribeOuterVisibility?.((visible) => handler(visible)) ?? null;
        return () => {
          propsDisposable?.dispose();
          outerDisposable?.();
        };
      },
      onDimensionsChange: (handler: () => void) => {
        const disposable = this.props?.api.onDidDimensionsChange(handler);
        return () => disposable?.dispose();
      },
      getResolvedTheme: (): ResolvedTheme => getResolvedTheme(),
      onThemeChange: (handler: (theme: ResolvedTheme) => void) => onThemeChange(handler)
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeState(current: unknown, next: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(isRecord(current) ? current : {}),
    ...next
  };
}

function omitPaneState<Params extends { state?: unknown }>(params: Params): Omit<Params, "state"> {
  const { state: _, ...rest } = params;
  return rest;
}

function createExtensionHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.className = "extension-host";
  host.style.cssText = "width:100%;height:100%;overflow:auto;";
  return host;
}

function resolveViewExport(moduleExports: Record<string, unknown>): FlmuxView<any, any> | null {
  const candidate = moduleExports.default ?? moduleExports.view;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  if (typeof (candidate as { createInstance?: unknown }).createInstance !== "function") {
    return null;
  }
  return candidate as FlmuxView<any, any>;
}

function isShallowEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}
