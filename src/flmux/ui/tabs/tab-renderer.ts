import {
  type AddPanelOptions,
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanelProps,
  type IWatermarkRenderer,
  type PanelUpdateEvent,
  type SerializedDockview
} from "dockview-core";
import type { HeaderAction } from "../../../types/view";
import { asPaneId, asTabId, type PaneId } from "../../../lib/ids";
import { getDefaultPaneTitle, isPaneParams, type PaneKind, type PaneParams } from "../../model/pane-params";
import { isLayoutableTabParams, type LayoutableTabParams } from "../../model/tab-params";
import type { GroupActionHandler } from "../chrome/group-actions";
import { GroupActionsRenderer } from "../chrome/group-actions";
import type { ExtensionSetupRegistry } from "../ext/extension-setup-registry";
import { formatWorkspaceTitle } from "../helpers";
import { PaneRenderer, type PaneRendererContext } from "../panes/pane-renderer";
import type { PaneTabMenuModel } from "./pane-tab-renderer";
import { PaneTabRenderer } from "./pane-tab-renderer";

export type TabRendererContext = {
  paneContext: PaneRendererContext;
  markDirty: () => void;
  register: (panelId: string, renderer: TabRenderer) => void;
  unregister: (panelId: string) => void;
  onGroupAction: GroupActionHandler;
  getTabIndex: (panelId: string) => number;
  setupRegistry: ExtensionSetupRegistry | null;
};

export class TabRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private _layoutMode: "simple" | "layoutable" | null = null;
  private paneRenderer: PaneRenderer | null = null;
  private _innerDockview: DockviewApi | null = null;
  private innerHost: HTMLElement | null = null;
  private innerResizeObserver: ResizeObserver | null = null;
  private layoutableParams: LayoutableTabParams | null = null;
  private simplePaneParams: PaneParams | null = null;
  private outerPanelId: string | null = null;
  private outerPanelApi: IDockviewPanelProps["api"] | null = null;
  private innerDisposables: Array<() => void> = [];
  private outerVisibilityCallbacks: Array<(visible: boolean) => void> = [];
  private paneHeaderActions = new Map<string, HeaderAction[]>();
  private groupActionRenderers: GroupActionsRenderer[] = [];
  private paneTabRenderers = new Map<string, PaneTabRenderer>();

  constructor(private readonly context: TabRendererContext) {
    this.element.className = "tab-shell";
  }

  get isLayoutable(): boolean {
    return this._layoutMode === "layoutable";
  }

  get innerApi(): DockviewApi | null {
    return this._innerDockview;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    const props = parameters as unknown as IDockviewPanelProps<Record<string, unknown>>;
    this.outerPanelId = props.api.id;
    this.outerPanelApi = props.api;
    this.context.register(this.outerPanelId, this);

    if (isLayoutableTabParams(props.params)) {
      this._layoutMode = "layoutable";
      this.layoutableParams = props.params as LayoutableTabParams;
      this.mountLayoutable(props.params as LayoutableTabParams);
    } else {
      this._layoutMode = "simple";
      this.layoutableParams = null;
      this.simplePaneParams = isPaneParams(props.params) ? props.params : null;
      this.paneRenderer = new PaneRenderer({
        ...this.context.paneContext,
        getTabId: () => asTabId(this.outerPanelId ?? "")
      });
      this.paneRenderer.init(parameters);
      this.element.append(this.paneRenderer.element);
    }
  }

  private mountLayoutable(params: LayoutableTabParams): void {
    this.layoutableParams = params;
    const host = document.createElement("div");
    host.className = "inner-workspace-host dockview-theme-flmux";
    this.innerHost = host;
    this.element.replaceChildren(host);

    this._innerDockview = createDockview(host, {
      theme: { name: "flmux", className: "dockview-theme-flmux" },
      noPanelsOverlay: "emptyGroup",
      defaultTabComponent: "flmux-pane-tab",
      defaultRenderer: "always",
      createWatermarkComponent: () => new WorkspaceWatermarkRenderer("Use + in the header to add a pane."),
      createComponent: () =>
        new PaneRenderer({
          ...this.context.paneContext,
          getTabId: () => asTabId(this.outerPanelId ?? ""),
          subscribeOuterVisibility: (cb) => {
            this.outerVisibilityCallbacks.push(cb);
            return () => {
              this.outerVisibilityCallbacks = this.outerVisibilityCallbacks.filter((c) => c !== cb);
            };
          },
          onHeaderActionsChanged: (paneId, actions) => {
            this.paneHeaderActions.set(String(paneId), actions);
            this.paneTabRenderers.get(String(paneId))?.refreshActions();
          }
        }),
      createTabComponent: (options) => {
        const tab = new PaneTabRenderer((panelId) => this.getPaneTabMenuModel(panelId));
        this.paneTabRenderers.set(options.id, tab);
        return tab as unknown as import("dockview-core").ITabRenderer;
      },
      createLeftHeaderActionComponent: (group: DockviewGroupPanel) => {
        const gar = new GroupActionsRenderer(
          group,
          (action, panelId) => this.context.onGroupAction(action, panelId),
          this.context.setupRegistry
        );
        this.groupActionRenderers.push(gar);
        return gar;
      }
    });

    if (params.innerLayout) {
      try {
        this._innerDockview.fromJSON(params.innerLayout as SerializedDockview);
      } catch {
        // ignore invalid inner layout
      }
    }
    this.ensureEmptyGroup();

    this._innerDockview.onDidLayoutChange(() => this.context.markDirty());
    this._innerDockview.onDidAddPanel(() => this.syncOuterTitle());
    this._innerDockview.onDidRemovePanel((panel) => {
      const paneId = asPaneId(panel.id);
      this.paneHeaderActions.delete(panel.id);
      this.paneTabRenderers.delete(panel.id);
      this.context.paneContext.firePreCloseHook(paneId);
      this.context.paneContext.onPaneRemoved?.(paneId, asTabId(this.outerPanelId ?? ""));
      this.ensureEmptyGroup();
      this.syncOuterTitle();
    });

    if (this.outerPanelApi) {
      const dimDisp = this.outerPanelApi.onDidDimensionsChange(() => this.layoutInner());
      const visDisp = this.outerPanelApi.onDidVisibilityChange(() => {
        const visible = this.outerPanelApi?.isVisible ?? false;
        for (const cb of this.outerVisibilityCallbacks) cb(visible);
        if (visible) {
          requestAnimationFrame(() => this.layoutInner());
        }
      });
      this.innerDisposables.push(
        () => dimDisp.dispose(),
        () => visDisp.dispose()
      );
    }

    this.innerResizeObserver = new ResizeObserver(() => this.layoutInner());
    this.innerResizeObserver.observe(host);

    requestAnimationFrame(() => {
      this.layoutInner();
      this.syncOuterTitle();
    });
  }

  addPane(
    paneId: PaneId,
    params: PaneParams,
    options: {
      initialTitle?: string;
      position?: { referencePanel: string; direction: string };
    } = {}
  ): void {
    if (!this._innerDockview) {
      return;
    }

    const panelOptions: AddPanelOptions<PaneParams> = {
      id: paneId,
      component: "flmux-pane",
      title: options.initialTitle ?? getDefaultPaneTitle(params.kind),
      params
    };

    if (options.position) {
      panelOptions.position = {
        referencePanel: options.position.referencePanel,
        direction: options.position.direction as "within" | "left" | "right" | "above" | "below"
      };
    }

    this._innerDockview.addPanel(panelOptions);
  }

  flushInnerLayout(): void {
    if (!this._innerDockview || !this.outerPanelApi || !this.layoutableParams) {
      return;
    }

    const innerLayout = this._innerDockview.toJSON();
    const activePaneId = this._innerDockview.activePanel ? asPaneId(this._innerDockview.activePanel.id) : null;
    this.layoutableParams = {
      ...this.layoutableParams,
      innerLayout,
      activePaneId
    };
    this.outerPanelApi.updateParameters({ innerLayout, activePaneId });
  }

  getWorkspaceTitle(): string | null {
    return this.outerPanelApi?.title ?? null;
  }

  setWorkspaceTitle(title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle || !this.outerPanelApi) {
      return;
    }

    if (!this.isLayoutable) {
      this.outerPanelApi.setTitle(nextTitle);
      return;
    }

    this.layoutableParams = {
      ...(this.layoutableParams ?? {
        tabKind: "tab",
        layoutMode: "layoutable",
        innerLayout: null,
        activePaneId: null
      }),
      customTitle: nextTitle
    };
    this.outerPanelApi.updateParameters({ customTitle: nextTitle });
    this.syncOuterTitle();
  }

  getPaneTitle(panelId: string): string | null {
    if (this.isLayoutable && this._innerDockview) {
      const panel = this._innerDockview.getPanel(panelId);
      if (panel && isPaneParams(panel.params)) {
        return panel.title ?? getDefaultPaneTitle(panel.params.kind);
      }
      return null;
    }

    if (this.outerPanelId !== panelId) {
      return null;
    }

    return this.outerPanelApi?.title ?? null;
  }

  setPaneTitle(panelId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    if (this.isLayoutable && this._innerDockview) {
      this._innerDockview.getPanel(panelId)?.api.setTitle(nextTitle);
      return;
    }

    if (this.outerPanelId === panelId) {
      this.outerPanelApi?.setTitle(nextTitle);
    }
  }

  getPaneParams(panelId: string): PaneParams | null {
    if (this.isLayoutable && this._innerDockview) {
      const panel = this._innerDockview.getPanel(panelId);
      return panel && isPaneParams(panel.params) ? panel.params : null;
    }
    if (this.outerPanelId === panelId) {
      return this.simplePaneParams;
    }
    return null;
  }

  updatePaneParams(
    panelId: string,
    patch: Partial<PaneParams>,
    options: { statePatch?: Record<string, unknown> } = {}
  ): void {
    if (this.isLayoutable && this._innerDockview) {
      const panel = this._innerDockview.getPanel(panelId);
      if (!panel || !isPaneParams(panel.params)) {
        throw new Error(`invalid pane params: ${panelId}`);
      }

      const nextState = options.statePatch
        ? mergePaneState(panel.params.state, options.statePatch)
        : panel.params.state;
      const nextParams: PaneParams = {
        ...panel.params,
        ...patch,
        state: nextState
      } as PaneParams;

      (panel.api as unknown as { updateParameters: (next: Record<string, unknown>) => void }).updateParameters(
        nextParams as unknown as Record<string, unknown>
      );
      this.context.markDirty();
      return;
    }

    if (this.outerPanelId !== panelId || !this.outerPanelApi || !this.simplePaneParams) {
      throw new Error(`invalid pane params: ${panelId}`);
    }

    const nextState = options.statePatch
      ? mergePaneState(this.simplePaneParams.state, options.statePatch)
      : this.simplePaneParams.state;
    const nextParams: PaneParams = {
      ...this.simplePaneParams,
      ...patch,
      state: nextState
    } as PaneParams;
    this.simplePaneParams = nextParams;
    (this.outerPanelApi as unknown as { updateParameters: (next: Record<string, unknown>) => void }).updateParameters(
      nextParams as unknown as Record<string, unknown>
    );
    this.context.markDirty();
  }

  private ensureEmptyGroup(): void {
    if (!this._innerDockview) {
      return;
    }

    if (this._innerDockview.groups.length === 0) {
      this._innerDockview.addGroup();
    }
  }

  private syncOuterTitle(): void {
    if (!this._innerDockview || !this.outerPanelApi || !this.outerPanelId) {
      return;
    }
    const idx = (this.context.getTabIndex?.(this.outerPanelId) ?? 0) + 1;
    const count = this._innerDockview.panels.length;
    this.outerPanelApi.setTitle(formatWorkspaceTitle(idx, count, this.layoutableParams?.customTitle));
  }

  private layoutInner(): void {
    if (!this._innerDockview || !this.innerHost) {
      return;
    }

    const rect = this.innerHost.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._innerDockview.layout(rect.width, rect.height, true);
    }
  }

  private getPaneTabMenuModel(panelId: string): PaneTabMenuModel {
    const panel = this._innerDockview?.panels.find((candidate) => candidate.id === panelId) ?? null;
    const params = isPaneParams(panel?.params) ? panel.params : null;
    const kind = params?.kind ?? "view";
    return {
      icon: paneKindIcon(kind),
      label: `${paneKindLabel(kind)} Menu`,
      tooltip: paneKindTooltip(params, panel?.title ?? ""),
      actions: this.paneHeaderActions.get(panelId) ?? []
    };
  }

  update(event: PanelUpdateEvent): void {
    if (this._layoutMode === "simple" && this.paneRenderer) {
      this.simplePaneParams = {
        ...(this.simplePaneParams ?? ({} as PaneParams)),
        ...event.params
      } as PaneParams;
      this.paneRenderer.update(event);
    }
  }

  dispose(): void {
    for (const dispose of this.innerDisposables) {
      dispose();
    }

    this.innerDisposables.length = 0;
    this.outerVisibilityCallbacks.length = 0;
    this.groupActionRenderers.length = 0;
    this.paneHeaderActions.clear();
    this.paneTabRenderers.clear();

    this.paneRenderer?.dispose();
    this.paneRenderer = null;

    if (this._innerDockview) {
      this._innerDockview.dispose();
      this._innerDockview = null;
    }

    this.innerResizeObserver?.disconnect();
    this.innerResizeObserver = null;
    this.innerHost = null;
    this.layoutableParams = null;
    this.simplePaneParams = null;

    if (this.outerPanelId) {
      this.context.unregister(this.outerPanelId);
      this.outerPanelId = null;
    }
    this.outerPanelApi = null;

    this.element.replaceChildren();
  }
}

function mergePaneState(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return { ...patch };
  }
  return {
    ...(current as Record<string, unknown>),
    ...patch
  };
}

class WorkspaceWatermarkRenderer implements IWatermarkRenderer {
  readonly element = document.createElement("div");

  constructor(message: string) {
    this.element.className = "workspace-watermark";
    this.element.textContent = message;
  }

  init(): void {}
}

function paneKindIcon(kind: PaneKind): string {
  switch (kind) {
    case "terminal":
      return "\u{1F5A5}\uFE0F";
    case "browser":
      return "\u{1F310}";
    case "editor":
      return "\u{1F4C4}";
    case "explorer":
      return "\u{1F4C1}";
    case "view":
      return "\u{1F9E9}";
  }
}

function paneKindLabel(kind: PaneKind): string {
  switch (kind) {
    case "terminal":
      return "Terminal";
    case "browser":
      return "Browser";
    case "editor":
      return "Editor";
    case "explorer":
      return "Explorer";
    case "view":
      return "View";
  }
}

function paneKindTooltip(params: PaneParams | null, currentTitle: string): string {
  if (!params) {
    return currentTitle;
  }

  switch (params.kind) {
    case "terminal":
      return params.cwd ?? currentTitle;
    case "browser":
      return params.url;
    case "editor":
      return params.filePath ?? currentTitle;
    case "explorer":
      return params.rootPath;
    case "view":
      return params.viewKey;
  }
}
