import type { ExtensionPaneDefinition } from "./pane";

export interface ExtensionDefinition {
  panes?: ExtensionPaneDefinition[];
}

export function defineExtension<T extends ExtensionDefinition>(definition: T): T {
  return definition;
}
