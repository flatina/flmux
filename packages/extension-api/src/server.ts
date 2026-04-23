import type { RPCTransport } from "bunite-core/shared/rpc";
import type { ShellClient } from "./shell";

/**
 * Server-side context for a single (pane × attachment) subscription.
 * `transport` is an isolated bunite channel — the extension pairs its own
 * schema to it via `defineBunRPC(...).setTransport(ctx.transport)`.
 *
 * One context is minted per connected pane per attachment. Device handoff
 * (same paneId re-subscribed from another attachment) triggers a fresh
 * `onPaneConnected` — the extension receives multiple independent rpc
 * instances keyed by (paneId, attachmentId) and decides whether to share
 * state in module-level singletons.
 */
export interface ExtensionServerPaneContext {
  transport: RPCTransport;
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
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerDefinition {
  onPaneConnected?(
    paneId: string,
    attachmentId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
