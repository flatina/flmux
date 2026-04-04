import type { DockviewGroupPanel, IGroupHeaderProps, IHeaderActionsRenderer } from "dockview-core";
import { addDisposableListener } from "dockview-core/dist/esm/events";
import type { PaneCreateDirection } from "../../../types/pane";
import type { ExtensionSetupRegistry } from "../ext/extension-setup-registry";
import { BUILTIN_PANE_SOURCES } from "../pane-sources";

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
      ? this.setupRegistry.resolveWorkspaceActions([])
      : [];
  }

  private getResolvedPaneSources() {
    return this.setupRegistry
      ? this.setupRegistry.resolvePaneSources(BUILTIN_PANE_SOURCES.map((source) => ({
          id: source.qualifiedId,
          icon: source.icon,
          label: source.label,
          order: source.order,
          defaultPlacement: source.defaultPlacement,
          createLeaf: source.createLeaf,
          options: source.options
        })))
      : [...BUILTIN_PANE_SOURCES];
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
    const paneSources = this.getResolvedPaneSources();
    const extensionActions = actions.filter((action) => !action.isBuiltin);

    const popup = document.createElement("div");
    popup.className = "group-actions-popup";
    document.body.appendChild(popup);
    this.popupMenu = popup;

    const group = this.currentGroup;
    if (paneSources.length > 0) {
      popup.append(this.buildPaneSourceGrid(group?.activePanel?.id ?? null, paneSources));
    } else {
      popup.append(this.buildEmptyState());
    }

    if (extensionActions.length > 0) {
      const separator = document.createElement("div");
      separator.className = "pane-tab-menu-separator";
      popup.append(separator);

      const extSection = document.createElement("div");
      extSection.className = "group-action-extension-list";
      for (const action of extensionActions) {
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
        extSection.append(item);
      }
      popup.append(extSection);
    }

    const rect = this.menuButton.getBoundingClientRect();
    popup.style.top = `${rect.top}px`;
    popup.style.left = `${rect.right + 4}px`;
  }

  private buildEmptyState(): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "group-actions-empty";
    empty.textContent = "No enabled pane sources.";
    return empty;
  }

  private buildPaneSourceGrid(
    activePanelId: string | null,
    sources: Array<{ qualifiedId: string; icon: string; label: string; defaultPlacement?: PaneCreateDirection }>
  ): HTMLElement {
    const section = document.createElement("div");
    section.className = "group-action-grid";
    const maxLabelLength = Math.max(...sources.map((source) => source.label.length), 0);
    section.style.setProperty("--group-action-source-width", `${Math.max(maxLabelLength + 3, 12)}ch`);

    const placements: Array<{ key: PaneCreateDirection; icon: string; label: string }> = [
      { key: "left", icon: "\u2190", label: "Split Left" },
      { key: "right", icon: "\u2192", label: "Split Right" },
      { key: "within", icon: "\u25CF", label: "Add In Tab" },
      { key: "below", icon: "\u2193", label: "Split Down" },
      { key: "above", icon: "\u2191", label: "Split Up" }
    ];

    for (const source of sources) {
      const row = document.createElement("div");
      row.className = "group-action-grid-row";

      const sourceBtn = document.createElement("button");
      sourceBtn.type = "button";
      sourceBtn.className = "group-action-grid-source-btn";
      sourceBtn.title = source.label;
      sourceBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePopup();
        this.onAction(`pane-source:${source.qualifiedId}:default`, activePanelId);
      });

      const sourceIcon = document.createElement("span");
      sourceIcon.className = "group-action-grid-source-icon";
      sourceIcon.textContent = source.icon;

      const sourceLabel = document.createElement("span");
      sourceLabel.className = "group-action-grid-source-label";
      sourceLabel.textContent = source.label;

      sourceBtn.append(sourceIcon, sourceLabel);
      row.append(sourceBtn);

      for (const placement of placements) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "group-action-grid-btn";
        btn.textContent = placement.icon;
        btn.title = placement.label;
        btn.disabled = placement.key !== "within" && !activePanelId;
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.closePopup();
          this.onAction(`pane-source:${source.qualifiedId}:${placement.key}`, activePanelId);
        });
        row.append(btn);
      }

      section.append(row);
    }

    return section;
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
