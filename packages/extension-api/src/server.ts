import type { Connection } from "bunite-core/rpc";
import type { ShellClient } from "./shell";
import type { ExtensionPaneSpec } from "./pane";

export interface ExtensionServerInitContext {
  dataDir: string;
}

/**
 * Per-client context for `onClientConnected`. Wire your cap via
 * `ctx.connection.serve(myCap, myImpl)` and return `{dispose}` that calls
 * `ctx.connection.unserve(myCap)` (or use `using h = ctx.connection.serve(...)`
 * with `Disposable` ServeHandle for auto-cleanup).
 */
export interface ExtensionServerClientContext {
  dataDir: string;
  /** ACL-aware ShellModelAPI client scoped to this client/user. Calls route
   * through the owning user's `allow_paths`. Use `/status/clients/{id}/userId`
   * for identity lookup when keying user-scoped session state. */
  shell: ShellClient;
  /** Bunite Connection shared with every cap on this client (flmux's
   * `flmux.shell` + sibling extension caps). Serve here; do not retain
   * across `dispose`. */
  connection: Connection;
}

/**
 * Per-pane lifecycle notification. Fires once per (pane × client). No RPC
 * binding — extensions wire RPC in `onClientConnected`. This hook is for
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
   * Host-side pane specs (kind → lifecycle / pathMount / persistence).
   * flmux reads this on the host without ever evaluating renderer code, so
   * pane specs never see DOM globals. Renderer-only extensions omit this
   * and fall back to manifest-level defaults.
   */
  panes?: ExtensionPaneSpec[];
  /**
   * Eager once-per-process setup, runs at extension load before any client
   * binds. Throw → server entry disabled.
   */
  onInit?(ctx: ExtensionServerInitContext): void | Promise<void>;
  /**
   * Per-client setup. Wire RPC caps here. Awaited by flmux before any
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
