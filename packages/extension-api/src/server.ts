import type { Connection } from "bunite-core/rpc";
import type { ShellClient } from "./shell";
import type { ExtensionPaneSpec } from "./pane";

export interface ExtensionServerInitContext {
  dataDir: string;
}

/**
 * Per-connection context for `serve`. Runs synchronously inside the bunite
 * connection setup so cap registration lands before any bootstrap frame can
 * arrive — module-top `bootstrap(extCap)` in renderer code is safe.
 */
export interface ExtensionServerServeContext {
  dataDir: string;
  /** Bunite Connection shared with every cap on this connection (flmux's
   * `flmux.shell` + sibling extension caps). Serve here, return a dispose
   * that unserves on connection close. */
  connection: Connection;
}

/**
 * Per-client context for `onClientConnected`. Notification-only — for
 * async per-client init (db connect, per-user session prep). **Do not**
 * register caps here; that happens in `serve` (synchronous, pre-bootstrap).
 */
export interface ExtensionServerClientContext {
  dataDir: string;
  /** ACL-aware ShellModelAPI client scoped to this client/user. Calls route
   * through the owning user's `allow_paths`. */
  shell: ShellClient;
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
   * Connection-setup cap registration. Runs synchronously inside bunite's
   * `serve` callback — every `conn.serve(cap, impl)` call here lands in
   * the registry before any renderer-side bootstrap frame can arrive.
   * Return `{dispose}` (or use the `Disposable` ServeHandle directly) so
   * the cap is unserved when the connection closes.
   *
   * Must be synchronous: no `await` before `conn.serve`. Async work
   * (db open, fetch) belongs in `onInit` (process-wide) or
   * `onClientConnected` (per-client, post-register).
   */
  serve?(ctx: ExtensionServerServeContext): { dispose?(): void } | void;
  /**
   * Per-client async init notification. Fires after `serve` and after
   * `shell.registerClient` binds the connection's clientId. No cap
   * registration here — that's `serve`'s job. May fire multiple times
   * for the same `clientId` across reconnects (cookie continuity).
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
