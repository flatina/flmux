import type { IHeaderActionsRenderer, IGroupHeaderProps, DockviewGroupPanel } from "dockview-core";

type Disposer = () => void;

class HeaderActionButton {
  readonly element = document.createElement("div");
  protected readonly button = document.createElement("button");
  private disposers: Disposer[] = [];

  constructor(label: string, title: string) {
    this.element.className = "header-action";
    this.button.type = "button";
    this.button.className = "header-action__btn";
    this.button.textContent = label;
    this.button.title = title;
    this.element.append(this.button);
  }

  protected addDisposer(dispose: Disposer) {
    this.disposers.push(dispose);
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.element.replaceChildren();
  }
}

export class WorkspaceHeaderActions implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  private readonly resetButton = document.createElement("button");
  private readonly addButton = document.createElement("button");
  private disposers: Array<() => void> = [];

  constructor(
    _group: DockviewGroupPanel,
    private readonly handlers: { onAdd: () => void; onResetActive: () => void }
  ) {
    this.element.className = "header-action";
    this.resetButton.type = "button";
    this.resetButton.className = "header-action__btn";
    this.resetButton.textContent = "\u21BB";
    this.resetButton.title = "Reset Active Workspace";
    this.addButton.type = "button";
    this.addButton.className = "header-action__btn";
    this.addButton.textContent = "+";
    this.addButton.title = "New Workspace";
    this.element.append(this.resetButton, this.addButton);
  }

  init(_params: IGroupHeaderProps) {
    const addListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onAdd();
    };
    const resetListener = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onResetActive();
    };
    this.addButton.addEventListener("click", addListener);
    this.resetButton.addEventListener("click", resetListener);
    this.disposers.push(
      () => this.addButton.removeEventListener("click", addListener),
      () => this.resetButton.removeEventListener("click", resetListener)
    );
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.element.replaceChildren();
  }
}

export interface PaneKindOption {
  kind: string;
  label: string;
}

export class NewPaneHeaderAction extends HeaderActionButton implements IHeaderActionsRenderer {
  private popup: HTMLDivElement | null = null;

  constructor(
    _group: DockviewGroupPanel,
    private readonly options: {
      listKinds: () => PaneKindOption[];
      onSelect: (kind: string) => void;
    }
  ) {
    super("+", "New Pane");
  }

  init(_params: IGroupHeaderProps) {
    const clickListener = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePopup();
    };
    this.button.addEventListener("click", clickListener);
    this.addDisposer(() => this.button.removeEventListener("click", clickListener));

    const documentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (this.element.contains(target) || this.popup?.contains(target))) {
        return;
      }
      this.closePopup();
    };
    document.addEventListener("pointerdown", documentPointerDown);
    this.addDisposer(() => document.removeEventListener("pointerdown", documentPointerDown));
  }

  private togglePopup() {
    if (this.popup) {
      this.closePopup();
    } else {
      this.openPopup();
    }
  }

  private openPopup() {
    const kinds = this.options.listKinds();
    const popup = document.createElement("div");
    popup.className = "header-action-popup";

    if (kinds.length === 0) {
      const empty = document.createElement("div");
      empty.className = "header-action-popup__empty";
      empty.textContent = "No pane kinds registered.";
      popup.append(empty);
    } else {
      for (const option of kinds) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "header-action-popup__item";
        item.textContent = `New ${option.label}`;
        item.dataset.kind = option.kind;
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.closePopup();
          this.options.onSelect(option.kind);
        });
        popup.append(item);
      }
    }

    document.body.append(popup);
    this.popup = popup;

    const rect = this.button.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(4, rect.right - popup.offsetWidth)}px`;
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  override dispose() {
    this.closePopup();
    super.dispose();
  }
}

export function humanizePaneKind(kind: string): string {
  return (
    kind
      .split(/[./_-]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || kind
  );
}
