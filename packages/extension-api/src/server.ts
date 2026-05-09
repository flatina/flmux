import type { RpcChannelHandle } from "bunite-core";
import type { ShellClient } from "./shell";

// Re-exported so extensions don't need a direct bunite-core dep just to
// name the channel type. `RpcChannelHandle.bindTo(rpc)` resolves once both
// sides register handlers (HELLO); await it before any send.
export type { RpcChannelHandle };

export interface ExtensionServerInitContext {
  dataDir: string;
}

/**
 * Per-client context for `onClientConnected`. Bind RPC channels here — once
 * per (extension × client). All panes of this client share these channels.
 * Channel name `<extId>:<name>` is namespaced by flmux; `name` is the
 * extension-supplied logical name.
 */
export interface ExtensionServerClientContext {
  dataDir: string;
  /**
   * ACL-aware ShellModelAPI client scoped to this client/user. Calls route
   * through the owning user's `allow_paths`. Use `/status/clients/{id}/userId`
   * for identity lookup when keying user-scoped session state.
   */
  shell: ShellClient;
  /** Returns a channel handle for `<extId>:<name>`. Default name is `"default"`. */
  channel(name?: string): RpcChannelHandle;
}

/**
 * Per-pane lifecycle notification. Fires once per (pane × client). No RPC
 * channel — extensions wire RPC in `onClientConnected`. This hook is for
 * pane-level bookkeeping (e.g. tracking which panes are alive on this client).
 */
export interface ExtensionServerPaneContext {
  dataDir: string;
  shell: ShellClient;
}

export interface ExtensionServerClientInstance {
  dispose?(): void;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerDefinition {
  /**
   * Eager once-per-process setup, runs at extension load before any client
   * binds. Throw → server entry disabled.
   */
  onInit?(ctx: ExtensionServerInitContext): void | Promise<void>;
  /**
   * Per-client setup. Bind RPC channels here. Awaited by flmux before any
   * `onPaneConnected` fires for this client. May fire multiple times for the
   * same `clientId` across reconnects (cookie continuity) — treat each as
   * fresh state.
   */
  onClientConnected?(
    clientId: string,
    ctx: ExtensionServerClientContext
  ): ExtensionServerClientInstance | void | Promise<ExtensionServerClientInstance | void>;
  /**
   * Per-pane lifecycle notification. Fires after `onClientConnected` resolves.
   * Use for pane-level bookkeeping; RPC binding belongs in `onClientConnected`.
   */
  onPaneConnected?(
    paneId: string,
    clientId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void | Promise<ExtensionServerPaneInstance | void>;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
