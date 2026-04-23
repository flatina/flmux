import type { RPCTransport } from "bunite-core/shared/rpc";

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
