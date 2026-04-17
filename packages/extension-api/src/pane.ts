import type {
  NewPaneInput as CoreNewPaneInput,
  PaneKind as CorePaneKind,
  PanePlacement as CorePanePlacement
} from "@flmux/core/shell";
import type { WorkspaceBusClient } from "./bus";
import type { ShellClient } from "./shell";
import type { PaneStateStore } from "./state";

export type PanePlacement = CorePanePlacement;
export type PaneKind = CorePaneKind;
export type NewPaneInput = CoreNewPaneInput;

export interface ExtensionPaneContext {
  paneId: string;
  workspaceId: string;
  shell: ShellClient;
  bus: WorkspaceBusClient;
  state: PaneStateStore;
}

export interface ExtensionPaneInstance {
  update?(params: Record<string, unknown>): void;
  layout?(width: number, height: number): void;
  focus?(): void;
  toJSON?(): Record<string, unknown>;
  dispose?(): void;
}

export interface ExtensionPanePathMountSnapshotArgs {
  paneId: string;
  workspaceId: string;
  installRoot: string;
  defaultBrowserPath: string;
  currentParams: Record<string, unknown> | undefined;
}

export interface ExtensionPanePathMountSetArgs extends ExtensionPanePathMountSnapshotArgs {
  relativePath: string[];
  value: unknown;
  setParams(nextParams: Record<string, unknown>): Promise<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ExtensionPanePathMountWritableArgs extends ExtensionPanePathMountSnapshotArgs {
  relativePath: string[];
}

export interface ExtensionPanePathMount {
  mountKey: string;
  getStateSnapshot?(args: ExtensionPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
  canSetStatePath?(args: ExtensionPanePathMountWritableArgs): boolean;
  setState?(args: ExtensionPanePathMountSetArgs): Promise<{ value: unknown }> | { value: unknown };
  getStatusSnapshot?(args: ExtensionPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
}

export interface ExtensionPaneDefinition {
  kind: string;
  mount(host: HTMLElement, context: ExtensionPaneContext): void | ExtensionPaneInstance;
  createParams?(args: {
    workspaceId: string;
    installRoot: string;
    defaultBrowserPath: string;
    input: NewPaneInput;
  }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspaceId: string;
    installRoot: string;
    defaultBrowserPath: string;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  normalizeRestoredParams?(args: {
    workspaceId: string;
    installRoot: string;
    defaultBrowserPath: string;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspaceId: string;
    installRoot: string;
    defaultBrowserPath: string;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  pathMount?: ExtensionPanePathMount;
}

export function definePane<T extends ExtensionPaneDefinition>(definition: T): T {
  return definition;
}
