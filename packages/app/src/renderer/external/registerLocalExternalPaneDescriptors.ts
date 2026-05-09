import type { ExtensionDefinition } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../../shared/rendererBridge";
import type { PaneDescriptor } from "../shell/paneRegistry";
import { createExternalPaneDescriptor } from "./runtime";
import { channelForExtension } from "./extensionChannelRegistry";

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
    const extId = extension.loadEntry.id;
    const paneIcons = extension.loadEntry.paneIcons ?? {};
    const paneDefaultTitles = extension.loadEntry.paneDefaultTitles ?? {};
    const paneMinimumWidths = extension.loadEntry.paneMinimumWidths ?? {};
    const paneMaximumWidths = extension.loadEntry.paneMaximumWidths ?? {};
    for (const pane of extension.definition.panes ?? []) {
      const descriptor = createExternalPaneDescriptor(extId, pane);
      if (paneIcons[pane.kind]) descriptor.iconUrl = paneIcons[pane.kind];
      if (paneDefaultTitles[pane.kind]) descriptor.defaultTitle = paneDefaultTitles[pane.kind];
      if (paneMinimumWidths[pane.kind] !== undefined) descriptor.minimumWidth = paneMinimumWidths[pane.kind];
      if (paneMaximumWidths[pane.kind] !== undefined) descriptor.maximumWidth = paneMaximumWidths[pane.kind];
      host.registerExternalPane(descriptor);
    }
  }

  // Eager `onLoad` — fire-and-forget. Cannot await before workbench.start:
  // onLoad's bindTo waits for the server-side `onClientConnected`, which only
  // fires inside the WS register handler (= inside workbench.start). Awaiting
  // here would deadlock. Extensions read the bound rpc lazily from
  // module-level state set inside onLoad's bindTo continuation; pane mounts
  // tolerate "rpc not yet ready" until then.
  for (const extension of discovered) {
    if (!extension.definition.onLoad) continue;
    const extId = extension.loadEntry.id;
    // `Promise.resolve().then(...)` — if `onLoad` throws synchronously
    // before returning a promise, the rejection still routes to `.catch`
    // (a bare `Promise.resolve(onLoad())` would propagate the sync throw).
    void Promise.resolve()
      .then(() =>
        extension.definition.onLoad!({
          channel: (name) => channelForExtension(extId, name)
        })
      )
      .catch((error) => {
        console.warn(`[flmux] extension '${extId}' onLoad failed`, error);
      });
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
