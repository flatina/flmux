import {
  type AddPanelOptions,
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanelProps,
  type PanelUpdateEvent,
  type SerializedDockview
} from "dockview-core";
import type { HeaderAction } from "../shared/extension-spi";
import { asPaneId, asTabId, type PaneId } from "../shared/ids";
import { isPaneParams, type PaneKind, type PaneParams } from "../shared/pane-params";
import { isLayoutableTabParams, type LayoutableTabParams } from "../shared/tab-params";
import type { ExtensionSetupRegistry } from "./extension-setup-registry";
import type { GroupActionHandler } from "./group-actions";
import { GroupActionsRenderer } from "./group-actions";
import { PaneRenderer, type PaneRendererContext } from "./pane-renderer";
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
      this.mountLayoutable(props.params as LayoutableTabParams);
    } else {
      this._layoutMode = "simple";
      this.paneRenderer = new PaneRenderer({
        ...this.context.paneContext,
        getTabId: () => asTabId(this.outerPanelId ?? "")
      });
      this.paneRenderer.init(parameters);
      this.element.append(this.paneRenderer.element);
    }
  }

  private mountLayoutable(params: LayoutableTabParams): void {
    const host = document.createElement("div");
    host.className = "inner-workspace-host dockview-theme-flmux";
    this.innerHost = host;
    this.element.replaceChildren(host);

    this._innerDockview = createDockview(host, {
      theme: { name: "flmux", className: "dockview-theme-flmux" },
      defaultTabComponent: "flmux-pane-tab",
      defaultRenderer: "always",
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
      createRightHeaderActionComponent: (group: DockviewGroupPanel) => {
        const gar = new GroupActionsRenderer(group, (action, panelId) => this.context.onGroupAction(action, panelId), this.context.setupRegistry);
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

    this._innerDockview.onDidLayoutChange(() => this.context.markDirty());
    this._innerDockview.onDidAddPanel(() => this.syncOuterTitle());
    this._innerDockview.onDidRemovePanel((panel) => {
      const paneId = asPaneId(panel.id);
      this.paneHeaderActions.delete(panel.id);
      this.paneTabRenderers.delete(panel.id);
      this.context.paneContext.firePreCloseHook(paneId);
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
    title: string,
    params: PaneParams,
    position?: { referencePanel: string; direction: string }
  ): void {
    if (!this._innerDockview) {
      return;
    }

    const panelOptions: AddPanelOptions<PaneParams> = {
      id: paneId,
      component: "flmux-pane",
      title,
      params
    };

    if (position) {
      panelOptions.position = {
        referencePanel: position.referencePanel,
        direction: position.direction as "within" | "left" | "right" | "above" | "below"
      };
    }

    this._innerDockview.addPanel(panelOptions);
  }

  flushInnerLayout(): void {
    if (!this._innerDockview || !this.outerPanelApi) {
      return;
    }

    const innerLayout = this._innerDockview.toJSON();
    const activePaneId = this._innerDockview.activePanel ? asPaneId(this._innerDockview.activePanel.id) : null;
    this.outerPanelApi.updateParameters({ innerLayout, activePaneId });
  }

  private syncOuterTitle(): void {
    if (!this._innerDockview || !this.outerPanelApi || !this.outerPanelId) {
      return;
    }
    const idx = (this.context.getTabIndex?.(this.outerPanelId) ?? 0) + 1;
    const count = this._innerDockview.panels.length;
    this.outerPanelApi.setTitle(`Workspace${idx} (${count} Tabs)`);
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

  private getPaneTabMenuModel(panelId: string): { icon: string; label: string; actions: HeaderAction[] } {
    const panel = this._innerDockview?.panels.find((candidate) => candidate.id === panelId) ?? null;
    const params = isPaneParams(panel?.params) ? panel.params : null;
    const kind = params?.kind ?? "extension";
    return {
      icon: paneKindIcon(kind),
      label: `${paneKindLabel(kind)} Menu`,
      actions: this.paneHeaderActions.get(panelId) ?? []
    };
  }

  update(event: PanelUpdateEvent): void {
    if (this._layoutMode === "simple" && this.paneRenderer) {
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

    if (this.outerPanelId) {
      this.context.unregister(this.outerPanelId);
      this.outerPanelId = null;
    }
    this.outerPanelApi = null;

    this.element.replaceChildren();
  }
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
    case "extension":
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
    case "extension":
      return "Extension";
  }
}
