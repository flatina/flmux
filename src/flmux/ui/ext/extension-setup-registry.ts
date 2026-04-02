import type { PaneCreateInput } from "../../../types/pane";
import type {
  ExtensionSetup,
  ExtensionSetupContext,
  WorkspaceActionContext,
  WorkspaceActionDescriptor,
  WorkspaceActionsModifier,
  PaneSourceDescriptor,
  WorkspaceTabDescriptor
} from "../../../types/setup";
import type { PropertyHandle } from "../../../types/property";
import { warn } from "../../../lib/logger";
import type { ExtensionSetupModule } from "../../model/bootstrap-state";
import { loadExtensionModule } from "./module-loader";

// ── Registered state ──

export interface RegisteredWorkspaceAction {
  /** Namespaced ID: `{extensionId}:{actionId}` */
  qualifiedId: string;
  icon: string;
  tooltip?: string;
  order: number;
  run: (ctx: WorkspaceActionContext) => void;
}

export interface RegisteredWorkspaceTab {
  qualifiedId: string;
  viewKey: string;
  title: string;
  singleton: boolean;
  titlebar?: {
    icon: string;
    tooltip?: string;
    order: number;
  };
}

export interface RegisteredPaneSource {
  qualifiedId: string;
  icon: string;
  label: string;
  order: number;
  defaultPlacement: PaneSourceDescriptor["defaultPlacement"];
  createLeaf: PaneSourceDescriptor["createLeaf"];
  options?: PaneSourceDescriptor["options"];
}

export interface TitlebarLauncherContext {
  openPaneInNewWorkspace(leaf: PaneCreateInput): Promise<void>;
  openWorkspaceTab(qualifiedId: string): void;
}

export interface ResolvedTitlebarLauncher {
  id: string;
  icon: string;
  tooltip: string;
  order: number;
  run: (ctx: TitlebarLauncherContext) => void | Promise<void>;
}

type ResolveWorkspaceActionsHandler = (modifier: WorkspaceActionsModifier) => void;

// ── Registry ──

export class ExtensionSetupRegistry {
  private readonly workspaceActions: RegisteredWorkspaceAction[] = [];
  private readonly paneSources: RegisteredPaneSource[] = [];
  private readonly resolveWorkspaceActionsHandlers: ResolveWorkspaceActionsHandler[] = [];
  private readonly workspaceTabs = new Map<string, RegisteredWorkspaceTab>();
  private readonly disposableStack = new DisposableStack();

  /** Sorted workspace actions after applying modifier hooks. */
  resolveWorkspaceActions(builtinActions: ReadonlyArray<{ id: string; icon: string; tooltip: string }>): Array<{
    id: string;
    icon: string;
    tooltip?: string;
    isBuiltin: boolean;
    run?: (ctx: WorkspaceActionContext) => void;
  }> {
    // Start with builtins
    const actions: Array<{
      id: string;
      icon: string;
      tooltip?: string;
      order: number;
      isBuiltin: boolean;
      run?: (ctx: WorkspaceActionContext) => void;
    }> = builtinActions.map((a, i) => ({ ...a, order: i * 10, isBuiltin: true }));

    // Add extension actions
    for (const ext of this.workspaceActions) {
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
    const modifier: WorkspaceActionsModifier = {
      hide(...ids: string[]) {
        for (const id of ids) hidden.add(id);
      }
    };
    for (const handler of this.resolveWorkspaceActionsHandlers) {
      try {
        handler(modifier);
      } catch (err) {
        warn("ext-setup", `onResolveWorkspaceActions handler error: ${err}`);
      }
    }

    return actions.filter((a) => !hidden.has(a.id)).sort((a, b) => a.order - b.order);
  }

  /** Find a registered workspace action by qualifiedId. */
  findWorkspaceAction(qualifiedId: string): RegisteredWorkspaceAction | undefined {
    return this.workspaceActions.find((a) => a.qualifiedId === qualifiedId);
  }

  resolvePaneSources(
    builtinSources: ReadonlyArray<{
      id: string;
      icon: string;
      label: string;
      order?: number;
      defaultPlacement?: PaneSourceDescriptor["defaultPlacement"];
      createLeaf: PaneSourceDescriptor["createLeaf"];
      options?: PaneSourceDescriptor["options"];
    }>
  ): RegisteredPaneSource[] {
    const sources: RegisteredPaneSource[] = builtinSources.map((source, index) => ({
      qualifiedId: source.id,
      icon: source.icon,
      label: source.label,
      order: source.order ?? index * 10,
      defaultPlacement: source.defaultPlacement,
      createLeaf: source.createLeaf,
      options: source.options
    }));

    for (const source of this.paneSources) {
      sources.push(source);
    }

    return sources.sort((left, right) => left.order - right.order);
  }

  findPaneSource(qualifiedId: string): RegisteredPaneSource | undefined {
    return this.paneSources.find((source) => source.qualifiedId === qualifiedId);
  }

  /** Find a registered workspace tab by qualifiedId. */
  findWorkspaceTab(qualifiedId: string): RegisteredWorkspaceTab | undefined {
    return this.workspaceTabs.get(qualifiedId);
  }

  listTitlebarWorkspaceTabs(): RegisteredWorkspaceTab[] {
    return Array.from(this.workspaceTabs.values())
      .filter((tab) => !!tab.titlebar)
      .sort((left, right) => (left.titlebar?.order ?? 100) - (right.titlebar?.order ?? 100));
  }

  resolveTitlebarLaunchers(
    builtinLaunchers: ReadonlyArray<{
      id: string;
      icon: string;
      tooltip: string;
      order?: number;
      run: (ctx: TitlebarLauncherContext) => void | Promise<void>;
    }>
  ): ResolvedTitlebarLauncher[] {
    const launchers: ResolvedTitlebarLauncher[] = builtinLaunchers.map((launcher, index) => ({
      id: launcher.id,
      icon: launcher.icon,
      tooltip: launcher.tooltip,
      order: launcher.order ?? index * 10,
      run: launcher.run
    }));

    for (const tab of this.workspaceTabs.values()) {
      if (!tab.titlebar) {
        continue;
      }

      launchers.push({
        id: tab.qualifiedId,
        icon: tab.titlebar.icon,
        tooltip: tab.titlebar.tooltip ?? tab.title,
        order: tab.titlebar.order,
        run: (ctx) => ctx.openWorkspaceTab(tab.qualifiedId)
      });
    }

    return launchers.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  /** Check if a qualifiedId belongs to any registered (or unregistered) extension workspace tab. */
  isExtensionTabId(qualifiedId: string): boolean {
    return qualifiedId.includes(":");
  }

  /** Load all extension setup modules and initialize them. */
  async loadAll(
    extensions: ReadonlyArray<ExtensionSetupModule>,
    app: PropertyHandle,
    extensionConfig: Record<string, Record<string, unknown>> = {}
  ): Promise<void> {
    // Phase 1: import all setup modules
    const setups: Array<{ extId: string; setup: ExtensionSetup }> = [];

    for (const ext of extensions) {
      if (!ext.source) continue;

      try {
        const mod = await loadExtensionModule<{ default?: ExtensionSetup } & Record<string, unknown>>(
          `setup:${ext.id}`,
          `flmux-ext://${ext.id}/setup.js`,
          async () => ext.source!
        );
        const setup = (mod.default ?? mod) as ExtensionSetup;
        setups.push({ extId: ext.id, setup });
      } catch (err) {
        warn("ext-setup", `Failed to load setup for ${ext.id}: ${err}`);
      }
    }

    // Phase 2: call onInit on all setups
    for (const { extId, setup } of setups) {
      if (typeof setup.onInit !== "function") continue;

      try {
        const ctx = this.buildContext(extId, app, extensionConfig[extId] ?? {});
        const disposable = setup.onInit(ctx);
        if (disposable) {
          this.disposableStack.use(disposable);
        }
      } catch (err) {
        warn("ext-setup", `onInit failed for ${extId}: ${err}`);
      }
    }
  }

  private buildContext(
    extensionId: string,
    app: PropertyHandle,
    config: Readonly<Record<string, unknown>>
  ): ExtensionSetupContext {
    return {
      extensionId,
      app,
      config,

      registerPaneSource: (source: PaneSourceDescriptor): Disposable => {
        const registered: RegisteredPaneSource = {
          qualifiedId: `${extensionId}:${source.id}`,
          icon: source.icon,
          label: source.label,
          order: source.order ?? 100,
          defaultPlacement: source.defaultPlacement,
          createLeaf: source.createLeaf,
          options: source.options
        };
        this.paneSources.push(registered);
        return {
          [Symbol.dispose]: () => {
            const idx = this.paneSources.indexOf(registered);
            if (idx >= 0) this.paneSources.splice(idx, 1);
          }
        };
      },

      registerWorkspaceAction: (action: WorkspaceActionDescriptor): Disposable => {
        const registered: RegisteredWorkspaceAction = {
          qualifiedId: `${extensionId}:${action.id}`,
          icon: action.icon,
          tooltip: action.tooltip,
          order: action.order ?? 100,
          run: action.run
        };
        this.workspaceActions.push(registered);
        return {
          [Symbol.dispose]: () => {
            const idx = this.workspaceActions.indexOf(registered);
            if (idx >= 0) this.workspaceActions.splice(idx, 1);
          }
        };
      },

      onResolveWorkspaceActions: (handler: (actions: WorkspaceActionsModifier) => void): Disposable => {
        this.resolveWorkspaceActionsHandlers.push(handler);
        return {
          [Symbol.dispose]: () => {
            const idx = this.resolveWorkspaceActionsHandlers.indexOf(handler);
            if (idx >= 0) this.resolveWorkspaceActionsHandlers.splice(idx, 1);
          }
        };
      },

      registerWorkspaceTab: (descriptor: WorkspaceTabDescriptor): Disposable => {
        const qualifiedId = `${extensionId}:${descriptor.id}`;
        const registered: RegisteredWorkspaceTab = {
          qualifiedId,
          viewKey: qualifiedId,
          title: descriptor.title,
          singleton: descriptor.singleton ?? false,
          titlebar: descriptor.titlebar
            ? {
                icon: descriptor.titlebar.icon,
                tooltip: descriptor.titlebar.tooltip,
                order: descriptor.titlebar.order ?? 100
              }
            : undefined
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
    this.workspaceActions.length = 0;
    this.paneSources.length = 0;
    this.resolveWorkspaceActionsHandlers.length = 0;
    this.workspaceTabs.clear();
  }
}
