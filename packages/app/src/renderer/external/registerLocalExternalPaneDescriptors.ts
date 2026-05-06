import type { ExtensionDefinition } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../../shared/rendererBridge";
import type { PaneDescriptor } from "../shell/paneRegistry";
import { createExternalPaneDescriptor } from "./runtime";

interface LocalExternalPaneRegistrationHost {
  registerExternalPane(descriptor: PaneDescriptor): void;
}

type ExtensionModule = {
  default?: ExtensionDefinition;
};

type ExtensionModuleImporter = (entryUrl: string) => Promise<ExtensionModule>;

export async function registerLocalExternalPaneDescriptors(
  host: LocalExternalPaneRegistrationHost,
  enabledExtensions: FlmuxLocalExtensionLoadEntry[],
  importer: ExtensionModuleImporter = importExtensionModule
) {
  const discovered = await loadLocalExtensionDefinitions(enabledExtensions, importer);
  const discoveredIds = new Set(discovered.map((extension) => extension.loadEntry.id));

  for (const extension of enabledExtensions) {
    if (!discoveredIds.has(extension.id)) {
      console.warn(`[flmux] local extension is in bootstrap catalog but failed to load in renderer: ${extension.id}`);
    }
  }

  for (const extension of discovered) {
    const paneIcons = extension.loadEntry.paneIcons ?? {};
    const paneDefaultTitles = extension.loadEntry.paneDefaultTitles ?? {};
    const paneMinimumWidths = extension.loadEntry.paneMinimumWidths ?? {};
    const paneMaximumWidths = extension.loadEntry.paneMaximumWidths ?? {};
    for (const pane of extension.definition.panes ?? []) {
      const descriptor = createExternalPaneDescriptor(pane);
      if (paneIcons[pane.kind]) descriptor.iconUrl = paneIcons[pane.kind];
      if (paneDefaultTitles[pane.kind]) descriptor.defaultTitle = paneDefaultTitles[pane.kind];
      if (paneMinimumWidths[pane.kind] !== undefined) descriptor.minimumWidth = paneMinimumWidths[pane.kind];
      if (paneMaximumWidths[pane.kind] !== undefined) descriptor.maximumWidth = paneMaximumWidths[pane.kind];
      host.registerExternalPane(descriptor);
    }
  }
}

export async function loadLocalExtensionDefinitions(
  enabledExtensions: FlmuxLocalExtensionLoadEntry[],
  importer: ExtensionModuleImporter = importExtensionModule
) {
  const discovered = await Promise.all(
    enabledExtensions.map(async (extension) => {
      try {
        const module = await importer(extension.rendererEntryUrl);
        if (!module.default) {
          console.warn(`[flmux] local extension module has no default export: ${extension.id}`);
          return null;
        }

        return {
          loadEntry: extension,
          definition: module.default
        };
      } catch (error) {
        console.warn(`[flmux] failed to load local extension module: ${extension.id}`, error);
        return null;
      }
    })
  );

  return discovered
    .filter(
      (entry): entry is { loadEntry: FlmuxLocalExtensionLoadEntry; definition: ExtensionDefinition } => entry !== null
    )
    .sort((left, right) => left.loadEntry.id.localeCompare(right.loadEntry.id));
}

async function importExtensionModule(entryUrl: string): Promise<ExtensionModule> {
  return await import(/* @vite-ignore */ entryUrl);
}
