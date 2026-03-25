import type { DockviewGroupPanel, IGroupHeaderProps, IHeaderActionsRenderer } from "dockview-core";
import { addDisposableListener } from "dockview-core/dist/esm/events";
import type { ExtensionSetupRegistry } from "./extension-setup-registry";

export const BUILTIN_ACTIONS: ReadonlyArray<{ id: string; icon: string; tooltip: string }> = [
  { id: "editor", icon: "📄", tooltip: "Add Editor" },
  { id: "explorer", icon: "📁", tooltip: "Add Explorer" },
  { id: "browser", icon: "\u{1F310}", tooltip: "Add Browser" },
  { id: "terminal", icon: ">_", tooltip: "Add Terminal" },
  { id: "split-right", icon: "\u25EB", tooltip: "Split Right" },
  { id: "split-down", icon: "\u229F", tooltip: "Split Down" }
];

export type GroupActionHandler = (action: string, activePanelId: string | null) => void;

export class GroupActionsRenderer implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  private readonly menuButton = document.createElement("button");
  private popupMenu: HTMLDivElement | null = null;
  private disposables: Array<{ dispose(): void } | (() => void)> = [];
  private currentGroup: IGroupHeaderProps["group"] | null = null;

  constructor(
    _group: DockviewGroupPanel,
    private readonly onAction: GroupActionHandler,
    private readonly setupRegistry: ExtensionSetupRegistry | null
  ) {
    this.element.className = "group-actions";
    this.menuButton.type = "button";
    this.menuButton.className = "group-action-btn group-action-menu-btn";
    this.menuButton.textContent = "\u2795";
    this.menuButton.title = "Add Pane";
    this.element.append(this.menuButton);
  }

  init(params: IGroupHeaderProps): void {
    this.currentGroup = params.group;
    this.disposables.push(
      addDisposableListener(this.menuButton, "pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }),
      addDisposableListener(this.menuButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.togglePopup();
      })
    );

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.element.contains(target) || this.popupMenu?.contains(target))) {
        return;
      }
      this.closePopup();
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    this.disposables.push({
      dispose: () => document.removeEventListener("pointerdown", handleDocumentPointerDown)
    });
  }

  private getResolvedActions() {
    return this.setupRegistry
      ? this.setupRegistry.resolveGroupActions(BUILTIN_ACTIONS)
      : BUILTIN_ACTIONS.map((a) => ({ ...a, isBuiltin: true as const, run: undefined }));
  }

  private togglePopup(): void {
    if (this.popupMenu) {
      this.closePopup();
      return;
    }
    this.openPopup();
  }

  private openPopup(): void {
    const actions = this.getResolvedActions();
    if (actions.length === 0) {
      return;
    }

    const popup = document.createElement("div");
    popup.className = "pane-tab-popup-menu";
    document.body.appendChild(popup);
    this.popupMenu = popup;

    const group = this.currentGroup;
    for (const [index, action] of actions.entries()) {
      const previous = index > 0 ? actions[index - 1] : null;
      if (previous && shouldSeparate(previous.id, previous.isBuiltin, action.id, action.isBuiltin)) {
        const separator = document.createElement("div");
        separator.className = "pane-tab-menu-separator";
        popup.append(separator);
      }

      const item = document.createElement("button");
      item.type = "button";
      item.className = "pane-tab-menu-item";
      item.textContent = action.tooltip ? `${action.icon}  ${action.tooltip}` : action.icon;
      item.title = action.tooltip ?? "";
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePopup();
        this.onAction(action.id, group?.activePanel?.id ?? null);
      });
      popup.append(item);
    }

    const rect = this.menuButton.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(8, rect.right - 160)}px`;
  }

  private closePopup(): void {
    this.popupMenu?.remove();
    this.popupMenu = null;
  }

  dispose(): void {
    this.closePopup();
    for (const d of this.disposables) {
      if (typeof d === "function") {
        d();
      } else {
        d.dispose();
      }
    }
    this.disposables.length = 0;
    this.currentGroup = null;
    this.element.replaceChildren();
  }
}

function isTerminalAction(id: string): boolean {
  return id === "terminal" || id === "split-right" || id === "split-down";
}

function shouldSeparate(
  previousId: string,
  previousBuiltin: boolean,
  nextId: string,
  nextBuiltin: boolean
): boolean {
  if (previousBuiltin !== nextBuiltin) {
    return true;
  }

  if (!previousBuiltin || !nextBuiltin) {
    return false;
  }

  return isTerminalAction(previousId) !== isTerminalAction(nextId);
}
