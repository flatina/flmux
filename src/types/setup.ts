import type { PaneCreateDirection, PaneCreateInput } from "./pane";
import type { PaneId, TabId } from "./ids";
import type { PropertyHandle } from "./property";

export interface PaneOpenOptions {
  singleton?: boolean;
}

export interface WorkspaceActionDescriptor {
  id: string;
  icon: string;
  tooltip?: string;
  order?: number;
  run: (ctx: WorkspaceActionContext) => void;
}

export interface PaneSourceDescriptor {
  id: string;
  icon: string;
  label: string;
  order?: number;
  defaultPlacement?: PaneCreateDirection | "auto";
  createLeaf: () => PaneCreateInput;
  options?: PaneOpenOptions;
}

export interface WorkspaceActionContext {
  activePaneId: PaneId | null;
  tabId: TabId;
  openPane: (
    leaf: PaneCreateInput,
    placement?: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
    options?: PaneOpenOptions
  ) => void;
  openWorkspaceTab: (id: string) => void;
}

export interface WorkspaceActionsModifier {
  hide(...ids: string[]): void;
}

export interface WorkspaceTabDescriptor {
  id: string;
  title: string;
  singleton?: boolean;
  titlebar?: {
    icon: string;
    tooltip?: string;
    order?: number;
  };
}

export interface ExtensionSetupContext {
  extensionId: string;
  readonly app: PropertyHandle;
  readonly config: Readonly<Record<string, unknown>>;
  registerPaneSource(source: PaneSourceDescriptor): Disposable;
  registerWorkspaceAction(action: WorkspaceActionDescriptor): Disposable;
  onResolveWorkspaceActions(handler: (actions: WorkspaceActionsModifier) => void): Disposable;
  registerWorkspaceTab(descriptor: WorkspaceTabDescriptor): Disposable;
}

export interface ExtensionSetup {
  onInit?(ctx: ExtensionSetupContext): Disposable | undefined;
}
