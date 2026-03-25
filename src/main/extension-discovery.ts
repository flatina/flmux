import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionManifest, ExtensionRegistryEntry } from "../shared/extension-spi";
import { isExtensionDisabled, loadExtensionSettings } from "../shared/extension-settings";
import { getExtensionsDir } from "../shared/paths";

const MANIFEST_FILENAME = "flmux-extension.json";
export const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export interface DiscoveredExtension {
  manifest: ExtensionManifest;
  path: string;
  embedded: boolean;
}

/**
 * Scan embedded (ext/) and installed ($XDG_DATA_HOME/flmux/extensions/) directories
 * for extensions with valid manifests.
 */
export function discoverExtensions(workspaceRoot: string): DiscoveredExtension[] {
  const results: DiscoveredExtension[] = [];
  const settings = loadExtensionSettings();

  // Embedded extensions: <workspaceRoot>/ext/<id>/
  const embeddedDir = join(workspaceRoot, "ext");
  scanDir(embeddedDir, true, results);

  // Installed extensions: $XDG_DATA_HOME/flmux/extensions/<id>/
  const installedDir = getExtensionsDir();
  scanDir(installedDir, false, results);

  return results.filter((ext) => !isExtensionDisabled(settings, ext.manifest.id));
}

/**
 * Discover all extensions including disabled ones (for ext list CLI).
 */
export function discoverAllExtensions(workspaceRoot: string): Array<DiscoveredExtension & { disabled: boolean }> {
  const results: DiscoveredExtension[] = [];
  const settings = loadExtensionSettings();

  const embeddedDir = join(workspaceRoot, "ext");
  scanDir(embeddedDir, true, results);

  const installedDir = getExtensionsDir();
  scanDir(installedDir, false, results);

  return results.map((ext) => ({
    ...ext,
    disabled: isExtensionDisabled(settings, ext.manifest.id)
  }));
}

/**
 * Build registry entries from discovered extensions for BootstrapState.
 */
export function buildExtensionRegistry(extensions: DiscoveredExtension[]): ExtensionRegistryEntry[] {
  return extensions.map((ext) => ({
    id: ext.manifest.id,
    name: ext.manifest.name,
    version: ext.manifest.version,
    setupEntry: ext.manifest.setupEntry,
    rendererEntry: ext.manifest.rendererEntry,
    embedded: ext.embedded,
    contributions: {
      panels: ext.manifest.contributions?.panels ?? [],
      events: ext.manifest.contributions?.events ?? []
    },
    permissions: ext.manifest.permissions ?? [],
    setupSource: loadSetupSource(ext)
  }));
}

function loadSetupSource(ext: DiscoveredExtension): string | undefined {
  const entry = ext.manifest.setupEntry;
  if (!entry) return undefined;

  if (!entry.startsWith("./") || entry.includes("..")) return undefined;

  const sourcePath = resolve(ext.path, entry);
  if (!sourcePath.startsWith(resolve(ext.path))) return undefined;

  try {
    const raw = readFileSync(sourcePath, "utf-8");
    return sourcePath.endsWith(".ts") || sourcePath.endsWith(".tsx")
      ? new Bun.Transpiler({ loader: sourcePath.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(raw)
      : raw;
  } catch {
    return undefined;
  }
}

/**
 * Read extension source file for renderer loading.
 */
export function loadExtensionSource(
  extensions: DiscoveredExtension[],
  extensionId: string
): { ok: true; source: string } | { ok: false; error: string } {
  const ext = extensions.find((e) => e.manifest.id === extensionId);
  if (!ext) {
    return { ok: false, error: `Extension not found: ${extensionId}` };
  }

  const entry = ext.manifest.rendererEntry;
  if (!entry) {
    return { ok: false, error: `Extension has no rendererEntry: ${extensionId}` };
  }

  // Validate entry path (must start with ./, no ..)
  if (!entry.startsWith("./") || entry.includes("..")) {
    return { ok: false, error: `Invalid rendererEntry path: ${entry}` };
  }

  const sourcePath = resolve(ext.path, entry);

  // Path traversal check
  if (!sourcePath.startsWith(resolve(ext.path))) {
    return { ok: false, error: `rendererEntry escapes extension directory: ${entry}` };
  }

  try {
    const raw = readFileSync(sourcePath, "utf-8");
    const source =
      sourcePath.endsWith(".ts") || sourcePath.endsWith(".tsx")
        ? new Bun.Transpiler({ loader: sourcePath.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(raw)
        : raw;
    return { ok: true, source };
  } catch (err) {
    return { ok: false, error: `Failed to read extension source: ${err}` };
  }
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
