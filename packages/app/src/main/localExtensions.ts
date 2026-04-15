import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { validateExtensionManifest, type ExtensionManifest } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../shared/rendererBridge";

const LOCAL_EXTENSION_CATALOG_FILENAME = "catalog.json";

export interface DiscoveredLocalExtension {
  id: string;
  name: string;
  rootDir: string;
  runtimeRootDir: string;
  runtimeManifestPath: string;
  runtimeManifest: ExtensionManifest;
  rendererEntryPath: string | null;
  cliEntryPath: string | null;
  version: string;
}

export interface LocalExtensionCatalogConfig {
  additionalRoots?: string[];
  enabled?: string[];
  disabled?: string[];
}

interface LocalExtensionCatalogPolicy {
  rootDir: string;
  additionalRoots: string[];
  enabledSelectors: string[];
  disabledSelectors: string[];
}

export async function discoverLocalExtensions(rootDir: string): Promise<DiscoveredLocalExtension[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;

  try {
    entries = await readdir(rootDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const extensionRootDir = join(rootDir, entry.name);
        const runtimeRootDir = join(extensionRootDir, "dist");
        const runtimeManifestPath = join(runtimeRootDir, "manifest.json");

        try {
          if (!(await Bun.file(runtimeManifestPath).exists())) {
            console.warn(
              `[flmux] missing built local extension manifest: ${runtimeManifestPath} (run 'bun run build:extensions')`
            );
            return null;
          }

          const raw = await readFile(runtimeManifestPath, "utf8");
          const manifestResult = validateExtensionManifest(JSON.parse(raw));
          if (!manifestResult.ok) {
            console.warn(
              `[flmux] invalid built local extension manifest: ${runtimeManifestPath}\n- ${manifestResult.errors.join("\n- ")}`
            );
            return null;
          }
          const runtimeManifest = manifestResult.manifest;

          const rendererEntryPath = await resolveValidatedEntrypoint({
            extensionRootDir: runtimeRootDir,
            manifestPath: runtimeManifestPath,
            value: runtimeManifest.entrypoints.renderer,
            label: "renderer"
          });
          const cliEntryPath = await resolveValidatedEntrypoint({
            extensionRootDir: runtimeRootDir,
            manifestPath: runtimeManifestPath,
            value: runtimeManifest.entrypoints.cli,
            label: "cli"
          });

          if (!rendererEntryPath && !cliEntryPath) {
            console.warn(`[flmux] local extension has no usable built renderer or cli entrypoint: ${runtimeManifestPath}`);
            return null;
          }

          return {
            id: runtimeManifest.id,
            name: runtimeManifest.name,
            rootDir: extensionRootDir,
            runtimeRootDir,
            runtimeManifestPath,
            runtimeManifest,
            rendererEntryPath,
            cliEntryPath,
            version: runtimeManifest.version
          } satisfies DiscoveredLocalExtension;
        } catch (error) {
          console.warn(
            `[flmux] failed to read built local extension manifest: ${runtimeManifestPath}`,
            error
          );
          return null;
        }
      })
  );

  const discovered = manifests
    .filter((manifest): manifest is DiscoveredLocalExtension => manifest !== null)
    .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  const deduped: DiscoveredLocalExtension[] = [];
  const seen = new Set<string>();

  for (const extension of discovered) {
    const key = `${extension.id}@${extension.version}`;
    if (seen.has(key)) {
      console.warn(`[flmux] duplicate local extension id/version ignored: ${key}`);
      continue;
    }

    seen.add(key);
    deduped.push(extension);
  }

  return deduped;
}

export async function discoverConfiguredLocalExtensions(rootDir: string): Promise<DiscoveredLocalExtension[]> {
  const policy = await loadLocalExtensionCatalogPolicy(rootDir);
  const discoveredRoots = dedupePreservingOrder([policy.rootDir, ...policy.additionalRoots]);
  const discoveredByRoot = await Promise.all(
    discoveredRoots.map(async (catalogRoot) => ({
      rootDir: catalogRoot,
      extensions: await discoverLocalExtensions(catalogRoot)
    }))
  );

  const discovered: DiscoveredLocalExtension[] = [];
  const seen = new Set<string>();

  for (const entry of discoveredByRoot) {
    for (const extension of entry.extensions) {
      const key = `${extension.id}@${extension.version}`;
      if (seen.has(key)) {
        console.warn(`[flmux] duplicate local extension across catalog roots ignored: ${key}`);
        continue;
      }

      seen.add(key);
      discovered.push(extension);
    }
  }

  return discovered.filter((extension) => isExtensionEnabledByPolicy(extension, policy));
}

export function createLocalExtensionLoadEntries(
  extensions: DiscoveredLocalExtension[],
  appOrigin: string
): FlmuxLocalExtensionLoadEntry[] {
  return extensions
    .filter((extension) => extension.rendererEntryPath !== null)
    .map((extension) => {
      const baseUrl = `${appOrigin}/__flmux/ext/${encodeURIComponent(extension.id)}/${encodeURIComponent(extension.version)}`;
      const rendererEntrypoint = extension.runtimeManifest.entrypoints.renderer!;
      return {
        id: extension.id,
        name: extension.name,
        version: extension.version,
        manifestUrl: `${baseUrl}/manifest.json`,
        rendererEntryUrl: `${baseUrl}/${toServedExtensionPath(rendererEntrypoint)}`
      } satisfies FlmuxLocalExtensionLoadEntry;
    });
}

export function resolveConfiguredLocalExtensionsRootDir(defaultRootDir: string) {
  const override = process.env.FLMUX_EXTENSIONS_ROOT;
  const trimmedOverride = override?.trim();
  if (trimmedOverride) {
    return trimmedOverride;
  }

  return defaultRootDir;
}

function resolveExtensionRelativePath(rootDir: string, relativePath: string) {
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    return null;
  }

  const resolved = normalize(join(rootDir, relativePath));
  const relativeToRoot = relative(rootDir, resolved);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return null;
  }

  return resolved;
}

async function loadLocalExtensionCatalogPolicy(rootDir: string): Promise<LocalExtensionCatalogPolicy> {
  const configPath = join(rootDir, LOCAL_EXTENSION_CATALOG_FILENAME);
  let parsedConfig: unknown;

  try {
    if (!(await Bun.file(configPath).exists())) {
      return {
        rootDir,
        additionalRoots: [],
        enabledSelectors: [],
        disabledSelectors: []
      };
    }

    parsedConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    console.warn(
      `[flmux] failed to read local extension catalog config: ${configPath}`,
      error
    );
    return {
      rootDir,
      additionalRoots: [],
      enabledSelectors: [],
      disabledSelectors: []
    };
  }

  if (!isPlainObject(parsedConfig)) {
    console.warn(`[flmux] invalid local extension catalog config: ${configPath} must be a JSON object`);
    return {
      rootDir,
      additionalRoots: [],
      enabledSelectors: [],
      disabledSelectors: []
    };
  }

  const additionalRoots = resolveCatalogRoots(rootDir, parsedConfig.additionalRoots, configPath, "additionalRoots");
  const enabledSelectors = normalizeCatalogSelectors(parsedConfig.enabled, configPath, "enabled");
  const disabledSelectors = normalizeCatalogSelectors(parsedConfig.disabled, configPath, "disabled");

  return {
    rootDir,
    additionalRoots,
    enabledSelectors,
    disabledSelectors
  };
}

function resolveCatalogRoots(
  rootDir: string,
  value: unknown,
  configPath: string,
  label: "additionalRoots"
) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    console.warn(`[flmux] invalid local extension catalog config: '${label}' must be an array in ${configPath}`);
    return [];
  }

  const resolvedRoots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      console.warn(`[flmux] invalid local extension catalog config: '${label}' entries must be non-empty strings in ${configPath}`);
      continue;
    }

    resolvedRoots.push(isAbsolute(entry) ? normalize(entry) : normalize(join(rootDir, entry)));
  }

  return dedupePreservingOrder(resolvedRoots);
}

function normalizeCatalogSelectors(
  value: unknown,
  configPath: string,
  label: "enabled" | "disabled"
) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    console.warn(`[flmux] invalid local extension catalog config: '${label}' must be an array in ${configPath}`);
    return [];
  }

  const selectors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      console.warn(`[flmux] invalid local extension catalog config: '${label}' entries must be non-empty strings in ${configPath}`);
      continue;
    }

    selectors.push(entry.trim());
  }

  return dedupePreservingOrder(selectors);
}

function isExtensionEnabledByPolicy(extension: DiscoveredLocalExtension, policy: LocalExtensionCatalogPolicy) {
  const selectorSet = new Set([extension.id, `${extension.id}@${extension.version}`]);

  if (policy.disabledSelectors.some((selector) => selectorSet.has(selector))) {
    return false;
  }

  if (policy.enabledSelectors.length === 0) {
    return true;
  }

  return policy.enabledSelectors.some((selector) => selectorSet.has(selector));
}

function toServedExtensionPath(relativePath: string) {
  return relativePath.replace(/^\.\/+/, "");
}

async function resolveValidatedEntrypoint(options: {
  extensionRootDir: string;
  manifestPath: string;
  value: string | undefined;
  label: "renderer" | "cli";
}) {
  if (typeof options.value !== "string") {
    return null;
  }

  const resolved = resolveExtensionRelativePath(options.extensionRootDir, options.value);
  if (!resolved) {
    console.warn(
      `[flmux] invalid local extension ${options.label} entrypoint '${options.value}': ${options.manifestPath}`
    );
    return null;
  }

  if (!(await Bun.file(resolved).exists())) {
    console.warn(`[flmux] missing local extension ${options.label} entry: ${resolved}`);
    return null;
  }

  return resolved;
}

function dedupePreservingOrder(values: string[]) {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
