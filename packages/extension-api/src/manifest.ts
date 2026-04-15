export const FLMUX_EXTENSION_API_VERSION = 1;

export interface ExtensionManifestEntrypoints {
  renderer?: string;
  cli?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  entrypoints: ExtensionManifestEntrypoints;
}
