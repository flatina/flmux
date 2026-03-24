import type {
  ExtensionRegistryEntry,
  ExtensionSetup,
  ExtensionSetupContext,
  GroupActionContext,
  GroupActionDescriptor,
  GroupActionsModifier,
  WorkspaceTabDescriptor
} from "../shared/extension-spi";
import { warn } from "../shared/logger";

// ── Registered state ──

export interface RegisteredGroupAction {
  /** Namespaced ID: `{extensionId}:{actionId}` */
  qualifiedId: string;
  icon: string;
  tooltip?: string;
  order: number;
  run: (ctx: GroupActionContext) => void;
}

export interface RegisteredWorkspaceTab {
  qualifiedId: string;
  extensionId: string;
  contributionId: string;
  title: string;
  singleton: boolean;
}

type CreateGroupActionsHandler = (modifier: GroupActionsModifier) => void;

// ── Registry ──

export class ExtensionSetupRegistry {
  private readonly groupActions: RegisteredGroupAction[] = [];
  private readonly createGroupActionsHandlers: CreateGroupActionsHandler[] = [];
  private readonly workspaceTabs = new Map<string, RegisteredWorkspaceTab>();
  private readonly disposableStack = new DisposableStack();

  /** Sorted group actions after applying modifier hooks. */
  resolveGroupActions(builtinActions: ReadonlyArray<{ id: string; icon: string; tooltip: string }>): Array<{
    id: string;
    icon: string;
    tooltip?: string;
    isBuiltin: boolean;
    run?: (ctx: GroupActionContext) => void;
  }> {
    // Start with builtins
    const actions: Array<{
      id: string;
      icon: string;
      tooltip?: string;
      order: number;
      isBuiltin: boolean;
      run?: (ctx: GroupActionContext) => void;
    }> = builtinActions.map((a, i) => ({ ...a, order: i * 10, isBuiltin: true }));

    // Add extension actions
    for (const ext of this.groupActions) {
      actions.push({
        id: ext.qualifiedId,
        icon: ext.icon,
        tooltip: ext.tooltip,
        order: ext.order,
        isBuiltin: false,
        run: ext.run
      });
    }

    // Apply modifier hooks (hide etc.)
    const hidden = new Set<string>();
    const modifier: GroupActionsModifier = {
      hide(...ids: string[]) {
        for (const id of ids) hidden.add(id);
      }
    };
    for (const handler of this.createGroupActionsHandlers) {
      try {
        handler(modifier);
      } catch (err) {
        warn("ext-setup", `onCreateGroupActions handler error: ${err}`);
      }
    }

    return actions.filter((a) => !hidden.has(a.id)).sort((a, b) => a.order - b.order);
  }

  /** Find a registered group action by qualifiedId. */
  findGroupAction(qualifiedId: string): RegisteredGroupAction | undefined {
    return this.groupActions.find((a) => a.qualifiedId === qualifiedId);
  }

  /** Find a registered workspace tab by qualifiedId. */
  findWorkspaceTab(qualifiedId: string): RegisteredWorkspaceTab | undefined {
    return this.workspaceTabs.get(qualifiedId);
  }

  /** Check if a qualifiedId belongs to any registered (or unregistered) extension workspace tab. */
  isExtensionTabId(qualifiedId: string): boolean {
    return qualifiedId.includes(":");
  }

  /** Load all extension setup modules and initialize them. */
  async loadAll(extensions: ExtensionRegistryEntry[]): Promise<void> {
    // Phase 1: import all setup modules
    const setups: Array<{ extId: string; setup: ExtensionSetup }> = [];

    for (const ext of extensions) {
      if (!ext.setupSource) continue;

      try {
        const sourceWithUrl = `${ext.setupSource}\n//# sourceURL=flmux-ext://${ext.id}/setup.js`;
        const blob = new Blob([sourceWithUrl], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        const mod = await import(/* @vite-ignore */ blobUrl);
        URL.revokeObjectURL(blobUrl);

        const setup: ExtensionSetup = mod.default ?? mod;
        setups.push({ extId: ext.id, setup });
      } catch (err) {
        warn("ext-setup", `Failed to load setup for ${ext.id}: ${err}`);
      }
    }

    // Phase 2: call onInit on all setups
    for (const { extId, setup } of setups) {
      if (typeof setup.onInit !== "function") continue;

      try {
        const ctx = this.buildContext(extId);
        const disposable = setup.onInit(ctx);
        if (disposable) {
          this.disposableStack.use(disposable);
        }
      } catch (err) {
        warn("ext-setup", `onInit failed for ${extId}: ${err}`);
      }
    }
  }

  private buildContext(extensionId: string): ExtensionSetupContext {
    return {
      extensionId,

      registerGroupAction: (action: GroupActionDescriptor): Disposable => {
        const registered: RegisteredGroupAction = {
          qualifiedId: `${extensionId}:${action.id}`,
          icon: action.icon,
          tooltip: action.tooltip,
          order: action.order ?? 100,
          run: action.run
        };
        this.groupActions.push(registered);
        return {
          [Symbol.dispose]: () => {
            const idx = this.groupActions.indexOf(registered);
            if (idx >= 0) this.groupActions.splice(idx, 1);
          }
        };
      },

      onCreateGroupActions: (handler: (actions: GroupActionsModifier) => void): Disposable => {
        this.createGroupActionsHandlers.push(handler);
        return {
          [Symbol.dispose]: () => {
            const idx = this.createGroupActionsHandlers.indexOf(handler);
            if (idx >= 0) this.createGroupActionsHandlers.splice(idx, 1);
          }
        };
      },

      registerWorkspaceTab: (descriptor: WorkspaceTabDescriptor): Disposable => {
        const qualifiedId = `${extensionId}:${descriptor.id}`;
        const registered: RegisteredWorkspaceTab = {
          qualifiedId,
          extensionId,
          contributionId: descriptor.id,
          title: descriptor.title,
          singleton: descriptor.singleton ?? false
        };
        this.workspaceTabs.set(qualifiedId, registered);
        return {
          [Symbol.dispose]: () => {
            this.workspaceTabs.delete(qualifiedId);
          }
        };
      }
    };
  }

  [Symbol.dispose](): void {
    this.disposableStack.dispose();
    this.groupActions.length = 0;
    this.createGroupActionsHandlers.length = 0;
    this.workspaceTabs.clear();
  }
}
