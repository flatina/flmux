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
  rendererEntry?: string;
  embedded: boolean;
  contributions: {
    panels: ExtensionPanelContribution[];
    events: ExtensionEventContribution[];
  };
  permissions: string[];
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
  setState: (nextState: unknown) => void;
  getState: () => unknown;
  emit: (eventType: string, data: unknown) => void;
  on: (eventType: string, handler: (event: PaneEvent) => void, options?: EventSubscriptionOptions) => () => void;
}

export interface MountedExtension {
  update?: (context: ExtensionContext) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export type ExtensionMount = (
  host: HTMLElement,
  context: ExtensionContext
) => MountedExtension | undefined | Promise<MountedExtension | undefined>;

// ── CLI command ABI ──

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
