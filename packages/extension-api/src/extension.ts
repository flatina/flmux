import type { ExtensionPaneRenderer } from "./pane";

export interface ExtensionDefinition {
  panes?: ExtensionPaneRenderer[];
  /** Eager per-renderer setup. Runs after `shell.registerClient` so any
   *  extension `bootstrap(myCap)` finds its cap already served on the host
   *  side. Cache the proxy at module scope and share across panes. */
  onLoad?(): void | Promise<void>;
}

export function defineExtension<T extends ExtensionDefinition>(definition: T): T {
  return definition;
}
