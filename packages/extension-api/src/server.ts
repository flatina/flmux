import type { ChannelHandle } from "bunite-core";
import type { ShellClient } from "./shell";

// Re-export so extensions don't need to add `bunite-core` to their own
// deps just to name the channel type. `ChannelHandle.bindTo(rpc)` wires the
// rpc to the channel transport and returns a promise that resolves once
// both sides have registered handlers (HELLO handshake). Awaiting guarantees
// the first subsequent request/message reaches the peer.
export type { ChannelHandle };

/**
 * Server-side context for a single (pane × attachment) subscription.
 *
 * `channel` is an isolated bunite channel handle — the extension pairs its
 * own schema to it via `defineBunRPC(...)` and `await ctx.channel.bindTo(rpc)`.
 * Awaiting the bind is mandatory before sending requests; otherwise the
 * first packet can race the peer's handler registration and be dropped.
 *
 * One context is minted per connected pane per attachment. Device handoff
 * (same paneId re-subscribed from another attachment) triggers a fresh
 * `onPaneConnected` — the extension receives multiple independent rpc
 * instances keyed by (paneId, attachmentId) and decides whether to share
 * state in module-level singletons.
 */
export interface ExtensionServerPaneContext {
  channel: ChannelHandle;
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
