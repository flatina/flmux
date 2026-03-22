import type { DockviewGroupPanel, IGroupHeaderProps, IHeaderActionsRenderer } from "dockview-core";

export type GroupActionId = "terminal" | "browser" | "explorer" | "split-right" | "split-down";
export type GroupActionHandler = (action: GroupActionId, activePanelId: string | null) => void;

const ACTIONS: ReadonlyArray<{ id: GroupActionId; icon: string; tooltip: string }> = [
  { id: "explorer", icon: "📁", tooltip: "Add Explorer" },
  { id: "terminal", icon: ">_", tooltip: "Add Terminal" },
  { id: "browser", icon: "\u{1F310}", tooltip: "Add Browser" },
  { id: "split-right", icon: "\u25EB", tooltip: "Split Right" },
  { id: "split-down", icon: "\u229F", tooltip: "Split Down" }
];

export class GroupActionsRenderer implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");

  constructor(
    _group: DockviewGroupPanel,
    private readonly onAction: GroupActionHandler
  ) {
    this.element.className = "group-actions";
  }

  init(params: IGroupHeaderProps): void {
    const group = params.group;
    for (const action of ACTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "group-action-btn";
      btn.textContent = action.icon;
      btn.title = action.tooltip;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onAction(action.id, group.activePanel?.id ?? null);
      });
      this.element.append(btn);
    }
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}
