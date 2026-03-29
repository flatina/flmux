import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionManifest } from "../../types/manifest";
import { isExtensionDisabled, loadExtensionSettings } from "./extension-settings";
import { getExtensionsDir } from "../../lib/paths";
import { resolveEmbeddedExtensionRoot } from "../../lib/runtime-paths";

const MANIFEST_FILENAME = "flmux-extension.json";
export const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export interface DiscoveredExtension {
  manifest: ExtensionManifest;
  path: string;
  embedded: boolean;
}

export function discoverExtensions(embeddedRoot = resolveEmbeddedExtensionRoot() ?? process.cwd()): DiscoveredExtension[] {
  const results: DiscoveredExtension[] = [];
  const settings = loadExtensionSettings();

  scanEmbeddedExtensionDirs(embeddedRoot, results);

  const installedDir = getExtensionsDir();
  scanDir(installedDir, false, results);

  return results.filter((ext) => !isExtensionDisabled(settings, ext.manifest.id));
}

export function discoverAllExtensions(
  embeddedRoot = resolveEmbeddedExtensionRoot() ?? process.cwd()
): Array<DiscoveredExtension & { disabled: boolean }> {
  const results: DiscoveredExtension[] = [];
  const settings = loadExtensionSettings();

  scanEmbeddedExtensionDirs(embeddedRoot, results);

  const installedDir = getExtensionsDir();
  scanDir(installedDir, false, results);

  return results.map((ext) => ({
    ...ext,
    disabled: isExtensionDisabled(settings, ext.manifest.id)
  }));
}

function scanDir(dir: string, embedded: boolean, results: DiscoveredExtension[]): void {
  if (!existsSync(dir)) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!EXTENSION_ID_PATTERN.test(name)) continue;

    const extPath = join(dir, name);
    const manifestPath = join(extPath, MANIFEST_FILENAME);

    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as ExtensionManifest;

      if (!manifest.id || !manifest.name || !manifest.version) continue;

      results.push({ manifest, path: extPath, embedded });
    } catch {
      // skip invalid manifests
    }
  }
}

function scanEmbeddedExtensionDirs(embeddedRoot: string, results: DiscoveredExtension[]): void {
  scanDir(join(embeddedRoot, "ext"), true, results);
}
