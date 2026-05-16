import type { ExtensionPaneDefinition } from "./pane";

export interface ExtensionDefinition {
  panes?: ExtensionPaneDefinition[];
  /** Eager per-renderer setup. Awaited by flmux before pane.added events
   *  flow to this extension's panes. Use `bootstrap(myCap)` from
   *  `bunite-core/rpc/renderer` to get a typed proxy for your extension's
   *  cap; cache the result at module scope and share across panes. */
  onLoad?(): void | Promise<void>;
}

export function defineExtension<T extends ExtensionDefinition>(definition: T): T {
  return definition;
}
