import type { ExtensionDefinition, ExtensionManifest } from "@flmux/extension-api";
import type { PaneDescriptor } from "../shell/paneRegistry";
import { createExternalPaneDescriptor } from "./runtime";

export interface LocalExternalPaneRegistrationHost {
  registerExternalPane(descriptor: PaneDescriptor): void;
}

type ExtensionModule = {
  default: ExtensionDefinition;
};

const LOCAL_EXTENSION_MANIFESTS = import.meta.glob<ExtensionManifest>(
  "../../../../../extensions/*/manifest.json",
  { eager: true, import: "default" }
);

const LOCAL_EXTENSION_MODULES = import.meta.glob<ExtensionModule>(
  "../../../../../extensions/*/index.ts",
  { eager: true }
);

export function registerLocalExternalPaneDescriptors(host: LocalExternalPaneRegistrationHost) {
  for (const extension of discoverLocalExtensions()) {
    for (const pane of extension.definition.panes ?? []) {
      host.registerExternalPane(createExternalPaneDescriptor(pane));
    }
  }
}

function discoverLocalExtensions() {
  const extensionDirs = new Set<string>();
  for (const path of Object.keys(LOCAL_EXTENSION_MANIFESTS)) {
    extensionDirs.add(dirname(path));
  }
  for (const path of Object.keys(LOCAL_EXTENSION_MODULES)) {
    extensionDirs.add(dirname(path));
  }

  return [...extensionDirs]
    .map((dir) => {
      const manifest = LOCAL_EXTENSION_MANIFESTS[`${dir}/manifest.json`];
      const module = LOCAL_EXTENSION_MODULES[`${dir}/index.ts`];
      if (!manifest || !module?.default) {
        return null;
      }

      return {
        manifest,
        definition: module.default
      };
    })
    .filter((entry): entry is { manifest: ExtensionManifest; definition: ExtensionDefinition } => entry !== null)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

function dirname(path: string) {
  return path.replace(/\/[^/]+$/, "");
}
