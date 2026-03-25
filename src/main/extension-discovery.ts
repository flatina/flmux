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

function readExtensionTextFile(ext: DiscoveredExtension, relativePath: string, label: string): { ok: true; content: string } | { ok: false; error: string } {
  if (!relativePath.startsWith("./") || relativePath.includes("..")) {
    return { ok: false, error: `Invalid ${label} path: ${relativePath}` };
  }

  const resolvedPath = resolve(ext.path, relativePath);
  if (!resolvedPath.startsWith(resolve(ext.path))) {
    return { ok: false, error: `${label} escapes extension directory: ${relativePath}` };
  }

  try {
    return { ok: true, content: readFileSync(resolvedPath, "utf-8") };
  } catch (err) {
    return { ok: false, error: `Failed to read ${label}: ${err}` };
  }
}

function loadSetupSource(ext: DiscoveredExtension): string | undefined {
  const entry = ext.manifest.setupEntry;
  if (!entry) return undefined;

  const result = readExtensionTextFile(ext, entry, "setupEntry");
  if (!result.ok) return undefined;

  try {
    return entry.endsWith(".ts") || entry.endsWith(".tsx")
      ? new Bun.Transpiler({ loader: entry.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(result.content)
      : result.content;
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

  const text = readExtensionTextFile(ext, entry, "rendererEntry");
  if (!text.ok) return text;

  try {
    const source =
      entry.endsWith(".ts") || entry.endsWith(".tsx")
        ? new Bun.Transpiler({ loader: entry.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(text.content)
        : text.content;
    return { ok: true, source };
  } catch (err) {
    return { ok: false, error: `Failed to read extension source: ${err}` };
  }
}

export function loadExtensionAssetText(
  extensions: DiscoveredExtension[],
  extensionId: string,
  path: string
): { ok: true; content: string } | { ok: false; error: string } {
  const ext = extensions.find((e) => e.manifest.id === extensionId);
  if (!ext) {
    return { ok: false, error: `Extension not found: ${extensionId}` };
  }

  return readExtensionTextFile(ext, path, "asset");
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
