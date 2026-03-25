import type { PaneCreateDirection, PaneCreateInput } from "./app-rpc";
import type { PaneId, TabId } from "./ids";

// ── Manifest (flmux-extension.json) ──

export interface ExtensionEventContribution {
  id: string;
  description?: string;
}

export interface ExtensionPanelContribution {
  id: string;
  kind: "panel";
  title: string;
}

export interface ExtensionCommandContribution {
  id: string;
  description?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  setupEntry?: string;
  rendererEntry?: string;
  cliEntry?: string;
  contributions?: {
    panels?: ExtensionPanelContribution[];
    events?: ExtensionEventContribution[];
    commands?: ExtensionCommandContribution[];
  };
  permissions?: string[];
}

// ── Registry (passed via BootstrapState) ──

export interface ExtensionRegistryEntry {
  id: string;
  name: string;
  version: string;
  setupEntry?: string;
  rendererEntry?: string;
  embedded: boolean;
  contributions: {
    panels: ExtensionPanelContribution[];
    events: ExtensionEventContribution[];
  };
  permissions: string[];
  /** Pre-transpiled setup module source (set by main process during bootstrap). */
  setupSource?: string;
}

// ── Runtime context (passed to mount) ──

export interface PaneEvent {
  source: PaneId;
  tabId: TabId;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface EventSubscriptionOptions {
  global?: boolean;
}

export interface ExtensionContext {
  extensionId: string;
  contributionId: string;
  paneId: PaneId;
  tabId: TabId;
  initialState: unknown;
  loadAssetText: (path: string) => Promise<string>;
  setState: (nextState: unknown) => void;
  getState: () => unknown;
  emit: (eventType: string, data: unknown) => void;
  on: (eventType: string, handler: (event: PaneEvent) => void, options?: EventSubscriptionOptions) => () => void;
  setHeaderActions: (actions: HeaderAction[]) => void;
}

export interface HeaderAction {
  id: string;
  icon: string;
  tooltip?: string;
  onClick: () => void;
}

export interface MountedExtension {
  update?: (context: ExtensionContext) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
  getActions?(): HeaderAction[];
}

export type ExtensionMount = (
  host: HTMLElement,
  context: ExtensionContext
) => MountedExtension | undefined | Promise<MountedExtension | undefined>;

// ── CLI command SPI ──

export interface ExtensionCliContext {
  args: Record<string, unknown>;
  getClient: (sessionId?: string) => Promise<{ call: (method: string, params: unknown) => Promise<unknown> }>;
  output: (value: unknown) => void;
}

export interface ExtensionCliCommand {
  meta: { name: string; description?: string };
  args?: Record<string, { type: string; description?: string; required?: boolean }>;
  run: (ctx: ExtensionCliContext) => void | Promise<void>;
}

// ── Setup SPI (eager-loaded at renderer startup) ──

export interface GroupActionDescriptor {
  id: string;
  icon: string;
  tooltip?: string;
  order?: number;
  run: (ctx: GroupActionContext) => void;
}

export interface PaneOpenOptions {
  singleton?: boolean;
}

export interface GroupActionContext {
  activePaneId: PaneId | null;
  tabId: TabId;
  openPane: (
    leaf: PaneCreateInput,
    placement?: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
    options?: PaneOpenOptions
  ) => void;
  openWorkspaceTab: (id: string) => void;
}

export interface GroupActionsModifier {
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
  registerGroupAction(action: GroupActionDescriptor): Disposable;
  onCreateGroupActions(handler: (actions: GroupActionsModifier) => void): Disposable;
  registerWorkspaceTab(descriptor: WorkspaceTabDescriptor): Disposable;
}

export interface ExtensionSetup {
  onInit?(ctx: ExtensionSetupContext): Disposable | undefined;
}
