import type { RpcChannelHandle } from "./server";
import type { ExtensionPaneDefinition } from "./pane";

/**
 * Per-extension load context. flmux invokes `onLoad` once per renderer at
 * bootstrap, after the demuxer is wired and before any pane.added flows.
 * Bind RPC channels here for eager (race-free) handshake; lazy alternative
 * is to bind inside `mount` with a module-level guard.
 */
export interface ExtensionLoadContext {
  /** Returns a channel handle for `<extId>:<name>`. Default name is `"default"`. */
  channel(name?: string): RpcChannelHandle;
}

export interface ExtensionDefinition {
  panes?: ExtensionPaneDefinition[];
  /** Eager per-renderer setup. Awaited by flmux before pane.added events
   *  flow to this extension's panes — handshake completes before mount. */
  onLoad?(ctx: ExtensionLoadContext): void | Promise<void>;
}

export function defineExtension<T extends ExtensionDefinition>(definition: T): T {
  return definition;
}
