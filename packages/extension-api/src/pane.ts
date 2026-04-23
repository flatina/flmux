import type { WorkspaceBusClient } from "./bus";
import type { ChannelHandle } from "./server";
import type { ShellClient } from "./shell";
import type { PaneStateStore } from "./state";

// Structurally compatible with `@flmux/core/shell/types` — the host creates
// panes with exactly these shapes.
export type PanePlacement = "within" | "left" | "right" | "above" | "below";
export type PaneKind = "browser" | "terminal" | (string & {});

export interface NewPaneInput {
  kind: PaneKind;
  title?: string;
  url?: string;
  cwd?: string;
  params?: Record<string, unknown>;
  place?: PanePlacement;
  referencePaneId?: string;
}

export interface ExtensionPaneContext {
  paneId: string;
  workspaceId: string;
  shell: ShellClient;
  bus: WorkspaceBusClient;
  state: PaneStateStore;
  /**
   * Isolated bunite channel handle for private pane↔server-entry RPC. The
   * extension pairs its own `BuniteRPCSchema` to it via
   * `defineWebviewRPC<Schema>(...)` and `await ctx.channel.bindTo(rpc)` on
   * mount, then disposes the rpc in `ExtensionPaneInstance.dispose`.
   * Awaiting `bindTo` before the first request is mandatory — otherwise
   * the first packet may race the peer's handler registration.
   *
   * Optional — only present when the extension has a server entry and the
   * host has wired a channel for this pane. Absent in test fixtures that
   * don't exercise the channel axis.
   */
  channel?: ChannelHandle;
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
    defaultBrowserPath: string;
    input: NewPaneInput;
  }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  normalizeRestoredParams?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  pathMount?: ExtensionPanePathMount;
}

export function definePane<T extends ExtensionPaneDefinition>(definition: T): T {
  return definition;
}
