import type { RpcChannelHandle } from "bunite-core";
import type { ShellClient } from "./shell";

// Re-exported so extensions don't need a direct bunite-core dep just to
// name the channel type. `RpcChannelHandle.bindTo(rpc)` resolves once both
// sides register handlers (HELLO); await it before any send.
export type { RpcChannelHandle };

/**
 * Server-side context per (pane × attachment) subscription. Pair an rpc
 * to `rpcChannel` via `defineBunRpc(...)` + `await ctx.rpcChannel.bindTo(rpc)`.
 * Device handoff (same paneId from another attachment) mints a fresh
 * context — share state via module-level singletons if needed.
 */
export interface ExtensionServerPaneContext {
  rpcChannel: RpcChannelHandle;
  /**
   * ACL-aware ShellModelAPI client scoped to this subscription's
   * attachment/user. Calls route through the owning user's `allow_paths`
   * (same config file as HTTP ACL). Use `/status/attachments/{id}/userId`
   * for identity lookup when keying user-scoped session state.
   */
  shell: ShellClient;
  /**
   * Absolute path of `<rootDir>/.flmux/ext/<extensionId>/`, mkdir'd before
   * first delivery. "Stay inside" boundary is advisory, not syscall-enforced.
   * Web mode shares one `dataDir` across users — partition under
   * `<dataDir>/users/<userId>/` (resolve via
   * `ctx.shell.get("/status/attachments/<id>/userId")`) to avoid cross-user
   * leakage.
   */
  dataDir: string;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerInitContext {
  dataDir: string;
}

export interface ExtensionServerDefinition {
  /**
   * Eager once-per-process setup, runs at extension load before any
   * `onPaneConnected`. Throw → server entry disabled.
   */
  onInit?(ctx: ExtensionServerInitContext): void | Promise<void>;
  onPaneConnected?(
    paneId: string,
    attachmentId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void | Promise<ExtensionServerPaneInstance | void>;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
