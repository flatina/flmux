import type { DockviewGroupPanel, IGroupHeaderProps, IHeaderActionsRenderer } from "dockview-core";
import type { HeaderAction } from "../shared/extension-spi";
import type { ExtensionSetupRegistry } from "./extension-setup-registry";

export const BUILTIN_ACTIONS: ReadonlyArray<{ id: string; icon: string; tooltip: string }> = [
  { id: "explorer", icon: "📁", tooltip: "Add Explorer" },
  { id: "terminal", icon: ">_", tooltip: "Add Terminal" },
  { id: "browser", icon: "\u{1F310}", tooltip: "Add Browser" },
  { id: "split-right", icon: "\u25EB", tooltip: "Split Right" },
  { id: "split-down", icon: "\u229F", tooltip: "Split Down" }
];

export type GroupActionHandler = (action: string, activePanelId: string | null) => void;

/** Callback to query the active panel's header actions (push-model). */
export type HeaderActionsProvider = (panelId: string) => HeaderAction[];

export class GroupActionsRenderer implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  private groupActionsZone = document.createElement("div");
  private panelActionsZone = document.createElement("div");
  private disposables: Array<() => void> = [];
  private currentGroup: IGroupHeaderProps["group"] | null = null;

  constructor(
    _group: DockviewGroupPanel,
    private readonly onAction: GroupActionHandler,
    private readonly setupRegistry: ExtensionSetupRegistry | null,
    private readonly headerActionsProvider?: HeaderActionsProvider
  ) {
    this.element.className = "group-actions";
    this.groupActionsZone.className = "group-actions-zone";
    this.panelActionsZone.className = "panel-actions-zone";
    this.element.append(this.panelActionsZone, this.groupActionsZone);
  }

  init(params: IGroupHeaderProps): void {
    this.currentGroup = params.group;

    this.buildGroupActions();

    // Subscribe to active panel changes for panel-dependent actions
    if (this.headerActionsProvider) {
      const sub = params.group.api.onDidActivePanelChange(() => {
        this.buildPanelActions();
      });
      this.disposables.push(() => sub.dispose());
      this.buildPanelActions();
    }
  }

  /** Rebuild panel-dependent header actions (called on push updates from setHeaderActions). */
  refreshPanelActions(): void {
    this.buildPanelActions();
  }

  private buildGroupActions(): void {
    this.groupActionsZone.replaceChildren();
    const group = this.currentGroup;
    if (!group) return;

    const actions = this.setupRegistry
      ? this.setupRegistry.resolveGroupActions(BUILTIN_ACTIONS)
      : BUILTIN_ACTIONS.map((a) => ({ ...a, isBuiltin: true as const, run: undefined }));

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "group-action-btn";
      btn.textContent = action.icon;
      btn.title = action.tooltip ?? "";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onAction(action.id, group.activePanel?.id ?? null);
      });
      this.groupActionsZone.append(btn);
    }
  }

  private buildPanelActions(): void {
    this.panelActionsZone.replaceChildren();
    if (!this.headerActionsProvider || !this.currentGroup) return;

    const activeId = this.currentGroup.activePanel?.id;
    if (!activeId) return;

    const actions = this.headerActionsProvider(activeId);
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "group-action-btn panel-action-btn";
      btn.textContent = action.icon;
      btn.title = action.tooltip ?? "";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        action.onClick();
      });
      this.panelActionsZone.append(btn);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.disposables.length = 0;
    this.currentGroup = null;
    this.element.replaceChildren();
  }
}
