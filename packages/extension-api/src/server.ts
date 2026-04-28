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
   * attachment/user. Use for identity lookup (e.g. `/status/attachments/
   * {attachmentId}/userId` to key user-scoped session state) and for any
   * shell queries the extension needs. Calls route through the owning
   * user's `allow_paths` — permission is governed by the same config file
   * that drives HTTP ACL, so extension access per user is managed in one
   * place.
   */
  shell: ShellClient;
  /**
   * Absolute path of `<rootDir>/.flmux/ext/<extensionId>/`, mkdir'd before
   * first delivery. The extension owns the directory; the "stay inside"
   * boundary is advisory, not syscall-enforced.
   *
   * Web mode shares one `dataDir` across users — partition under
   * `<dataDir>/users/<userId>/` (resolve via
   * `ctx.shell.get("/status/attachments/<attachmentId>/userId")`) or risk
   * cross-user state leakage.
   */
  dataDir: string;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerDefinition {
  onPaneConnected?(
    paneId: string,
    attachmentId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void | Promise<ExtensionServerPaneInstance | void>;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
