import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { validateExtensionManifest, type ExtensionManifest } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../shared/rendererBridge";

const LOCAL_EXTENSION_CATALOG_FILENAME = "catalog.json";

/**
 * A discovered extension that the app loads. Either "source" (built into a
 * `dist/` directory — the dev workflow) or "archive" (packaged `.tar.gz` —
 * the distribution format). The two backends share a common resolver
 * interface so consumers (HTTP serving, CLI dispatch) don't branch on origin.
 */
export interface DiscoveredLocalExtension {
  id: string;
  name: string;
  version: string;
  runtimeManifest: ExtensionManifest;
  rendererEntryRelativePath: string | null;
  cliEntryRelativePath: string | null;
  serverEntryRelativePath: string | null;
  origin: "source" | "archive";
  /** Human-readable path for diagnostics: source dir or tarball path. */
  originPath: string;
  /** Return a Blob handle for a runtime-relative path ("index.js",
   * "_wasm/foo.wasm", …), or null if the file is absent. Source backend
   * returns `Bun.file(absPath)`; archive backend returns the in-memory `File`
   * from `Bun.Archive.files()`. Both are Blob-compatible — `new Response(blob)`
   * streams them. */
  resolveRuntimeFile(relativePath: string): Blob | null;
  /** Return an import-ready URL for a runtime-relative entry file. Source
   * returns `file://<absPath>`. Archive returns `data:text/javascript;base64,<...>`
   * built from the in-memory bytes — works because cli/server entries are
   * contract-bound to zero runtime externals (internal design). Returns
   * null if the relative path doesn't resolve. */
  resolveEntryImportUrl(relativePath: string): Promise<string | null>;
}

export interface LocalExtensionCatalogConfig {
  additionalRoots?: string[];
  tarballs?: string[];
  enabled?: string[];
  disabled?: string[];
}

interface LocalExtensionCatalogPolicy {
  rootDir: string;
  additionalRoots: string[];
  tarballPaths: string[];
  enabledSelectors: string[];
  disabledSelectors: string[];
}

export async function discoverLocalExtensions(rootDir: string): Promise<DiscoveredLocalExtension[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;

  try {
    entries = await readdir(rootDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  // Accept regular directories plus links that resolve to directories.
  // Bun on Windows reports directory junctions as symlinks (isDirectory()
  // returns false), so a plain isDirectory() filter would silently drop
  // link-backed extension roots. Follow the link via stat() to include them.
  const extensionDirs = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return entry.name;
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(join(rootDir, entry.name));
          if (target.isDirectory()) return entry.name;
        } catch {
          // dead link — skip silently
        }
      }
      return null;
    })
  );

  const manifests = await Promise.all(
    extensionDirs
      .filter((name): name is string => name !== null)
      .map((name) => discoverSourceExtension(join(rootDir, name)))
  );

  // Collapse same-id siblings within a single root (e.g., two folders
  // declaring the same extension id at different versions). Uses the same
  // highest-version rule as cross-backend collapsing so the two paths agree.
  return collapseById(manifests.filter((m): m is DiscoveredLocalExtension => m !== null));
}

export async function discoverConfiguredLocalExtensions(rootDir: string): Promise<DiscoveredLocalExtension[]> {
  const policy = await loadLocalExtensionCatalogPolicy(rootDir);
  const discoveredRoots = dedupePreservingOrder([policy.rootDir, ...policy.additionalRoots]);

  const sourceLists = await Promise.all(discoveredRoots.map((catalogRoot) => discoverLocalExtensions(catalogRoot)));
  const archiveExtensions = await Promise.all(policy.tarballPaths.map((path) => discoverArchiveExtension(path)));

  // id-per-single-version invariant: same id + different origins or different
  // versions collapse to one active entry. Source dir wins over archive
  // (dev workflow preserved); among archives, highest semver-ish version wins.
  const all = [...sourceLists.flat(), ...archiveExtensions.filter((e): e is DiscoveredLocalExtension => e !== null)];
  const collapsed = collapseById(all);

  return collapsed.filter((extension) => isExtensionEnabledByPolicy(extension, policy));
}

export interface LocalExtensionLoadEntriesOptions {
  /** Cache-bust query param value. Caller passes `Date.now().toString(36)` at
   * bootstrap so `location.reload()` re-fetches rebuilt extensions. Tests can
   * pin a fixed value for deterministic URLs. Pass `null` to omit the query. */
  cacheKey?: string | null;
}

export function createLocalExtensionLoadEntries(
  extensions: DiscoveredLocalExtension[],
  appOrigin: string,
  options: LocalExtensionLoadEntriesOptions = {}
): FlmuxLocalExtensionLoadEntry[] {
  const cacheKey = options.cacheKey === undefined ? Date.now().toString(36) : options.cacheKey;
  const query = cacheKey === null ? "" : `?v=${cacheKey}`;

  return extensions
    .filter((extension) => extension.rendererEntryRelativePath !== null)
    .map((extension) => {
      const baseUrl = `${appOrigin}/__flmux/ext/${encodeURIComponent(extension.id)}/${encodeURIComponent(extension.version)}`;
      const rendererEntrypoint = extension.rendererEntryRelativePath!;
      const paneIcons: Record<string, string> = {};
      const paneDefaultTitles: Record<string, string> = {};
      const paneMinimumSizes: Record<string, number> = {};
      const paneMaximumSizes: Record<string, number> = {};
      const paneInitialSizes: Record<string, number> = {};
      const paneEdgeGroups: Record<string, "left" | "right" | "top" | "bottom"> = {};
      const paneNewMenu: Record<string, boolean> = {};
      for (const pane of extension.runtimeManifest.panes ?? []) {
        if (pane.icon) {
          paneIcons[pane.kind] = `${baseUrl}/${toServedExtensionPath(pane.icon)}${query}`;
        }
        if (pane.defaultTitle) {
          paneDefaultTitles[pane.kind] = pane.defaultTitle;
        }
        if (pane.minimumSize !== undefined) {
          paneMinimumSizes[pane.kind] = pane.minimumSize;
        }
        if (pane.maximumSize !== undefined) {
          paneMaximumSizes[pane.kind] = pane.maximumSize;
        }
        if (pane.initialSize !== undefined) {
          paneInitialSizes[pane.kind] = pane.initialSize;
        }
        if (pane.edgeGroup) {
          paneEdgeGroups[pane.kind] = pane.edgeGroup;
        }
        if (pane.newMenu !== undefined) {
          paneNewMenu[pane.kind] = pane.newMenu;
        }
      }
      return {
        id: extension.id,
        name: extension.name,
        version: extension.version,
        manifestUrl: `${baseUrl}/manifest.json${query}`,
        rendererEntryUrl: `${baseUrl}/${toServedExtensionPath(rendererEntrypoint)}${query}`,
        paneIcons,
        paneDefaultTitles,
        paneMinimumSizes,
        paneMaximumSizes,
        paneInitialSizes,
        paneEdgeGroups,
        paneNewMenu
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

async function discoverSourceExtension(extensionRootDir: string): Promise<DiscoveredLocalExtension | null> {
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

    const rendererEntryRelativePath = await validateSourceEntrypoint(
      runtimeRootDir,
      runtimeManifestPath,
      runtimeManifest.entrypoints.renderer,
      "renderer"
    );
    const cliEntryRelativePath = await validateSourceEntrypoint(
      runtimeRootDir,
      runtimeManifestPath,
      runtimeManifest.entrypoints.cli,
      "cli"
    );
    const serverEntryRelativePath = await validateSourceEntrypoint(
      runtimeRootDir,
      runtimeManifestPath,
      runtimeManifest.entrypoints.server,
      "server"
    );

    if (!rendererEntryRelativePath && !cliEntryRelativePath && !serverEntryRelativePath) {
      console.warn(`[flmux] local extension has no usable built entrypoint: ${runtimeManifestPath}`);
      return null;
    }

    return {
      id: runtimeManifest.id,
      name: runtimeManifest.name,
      version: runtimeManifest.version,
      runtimeManifest,
      rendererEntryRelativePath,
      cliEntryRelativePath,
      serverEntryRelativePath,
      origin: "source",
      originPath: extensionRootDir,
      resolveRuntimeFile(relativePath: string): Blob | null {
        const full = resolveExtensionRelativePath(runtimeRootDir, relativePath);
        if (!full || !existsSync(full)) return null;
        return Bun.file(full);
      },
      async resolveEntryImportUrl(relativePath: string): Promise<string | null> {
        const full = resolveExtensionRelativePath(runtimeRootDir, relativePath);
        if (!full || !existsSync(full)) return null;
        return pathToFileURL(full).href;
      }
    };
  } catch (error) {
    console.warn(`[flmux] failed to read built local extension manifest: ${runtimeManifestPath}`, error);
    return null;
  }
}

async function discoverArchiveExtension(tarballPath: string): Promise<DiscoveredLocalExtension | null> {
  try {
    if (!(await Bun.file(tarballPath).exists())) {
      console.warn(`[flmux] extension tarball not found: ${tarballPath}`);
      return null;
    }

    const bytes = await Bun.file(tarballPath).bytes();
    // Bun.Archive auto-detects gzip on read, so the same call handles both
    // `.tar.gz` and bare `.tar`.
    const archive = new Bun.Archive(bytes);
    const files = await archive.files();

    const manifestFile = files.get("manifest.json");
    if (!manifestFile) {
      console.warn(`[flmux] extension tarball missing manifest.json: ${tarballPath}`);
      return null;
    }

    const manifestResult = validateExtensionManifest(JSON.parse(await manifestFile.text()));
    if (!manifestResult.ok) {
      console.warn(
        `[flmux] invalid extension tarball manifest: ${tarballPath}\n- ${manifestResult.errors.join("\n- ")}`
      );
      return null;
    }
    const runtimeManifest = manifestResult.manifest;

    const renderer = validateArchiveEntrypoint(files, runtimeManifest.entrypoints.renderer, "renderer", tarballPath);
    const cli = validateArchiveEntrypoint(files, runtimeManifest.entrypoints.cli, "cli", tarballPath);
    const server = validateArchiveEntrypoint(files, runtimeManifest.entrypoints.server, "server", tarballPath);

    if (!renderer && !cli && !server) {
      console.warn(`[flmux] extension tarball has no usable entrypoint: ${tarballPath}`);
      return null;
    }

    return {
      id: runtimeManifest.id,
      name: runtimeManifest.name,
      version: runtimeManifest.version,
      runtimeManifest,
      rendererEntryRelativePath: renderer,
      cliEntryRelativePath: cli,
      serverEntryRelativePath: server,
      origin: "archive",
      originPath: tarballPath,
      resolveRuntimeFile(relativePath: string): Blob | null {
        const key = normalizeArchiveKey(relativePath);
        return key === null ? null : (files.get(key) ?? null);
      },
      async resolveEntryImportUrl(relativePath: string): Promise<string | null> {
        const key = normalizeArchiveKey(relativePath);
        if (key === null) return null;
        const file = files.get(key);
        if (!file) return null;
        const entryBytes = await file.bytes();
        // Contract: cli/server entries have zero runtime externals, so
        // `data:` URL import (no resolution context) works reliably.
        return `data:text/javascript;base64,${Buffer.from(entryBytes).toString("base64")}`;
      }
    };
  } catch (error) {
    console.warn(`[flmux] failed to load extension tarball: ${tarballPath}`, error);
    return null;
  }
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

function normalizeArchiveKey(relativePath: string): string | null {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\")) {
    return null;
  }
  const normalized = normalize(relativePath).replace(/\\/g, "/");
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}

async function loadLocalExtensionCatalogPolicy(rootDir: string): Promise<LocalExtensionCatalogPolicy> {
  const configPath = join(rootDir, LOCAL_EXTENSION_CATALOG_FILENAME);
  let parsedConfig: unknown;

  try {
    if (!(await Bun.file(configPath).exists())) {
      return emptyCatalogPolicy(rootDir);
    }
    parsedConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    console.warn(`[flmux] failed to read local extension catalog config: ${configPath}`, error);
    return emptyCatalogPolicy(rootDir);
  }

  if (!isPlainObject(parsedConfig)) {
    console.warn(`[flmux] invalid local extension catalog config: ${configPath} must be a JSON object`);
    return emptyCatalogPolicy(rootDir);
  }

  return {
    rootDir,
    additionalRoots: resolveCatalogPaths(rootDir, parsedConfig.additionalRoots, configPath, "additionalRoots"),
    tarballPaths: resolveCatalogPaths(rootDir, parsedConfig.tarballs, configPath, "tarballs"),
    enabledSelectors: normalizeCatalogSelectors(parsedConfig.enabled, configPath, "enabled"),
    disabledSelectors: normalizeCatalogSelectors(parsedConfig.disabled, configPath, "disabled")
  };
}

function emptyCatalogPolicy(rootDir: string): LocalExtensionCatalogPolicy {
  return {
    rootDir,
    additionalRoots: [],
    tarballPaths: [],
    enabledSelectors: [],
    disabledSelectors: []
  };
}

function resolveCatalogPaths(
  rootDir: string,
  value: unknown,
  configPath: string,
  label: "additionalRoots" | "tarballs"
) {
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    console.warn(`[flmux] invalid local extension catalog config: '${label}' must be an array in ${configPath}`);
    return [];
  }

  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      console.warn(
        `[flmux] invalid local extension catalog config: '${label}' entries must be non-empty strings in ${configPath}`
      );
      continue;
    }
    resolved.push(isAbsolute(entry) ? normalize(entry) : normalize(join(rootDir, entry)));
  }

  return dedupePreservingOrder(resolved);
}

function normalizeCatalogSelectors(value: unknown, configPath: string, label: "enabled" | "disabled") {
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    console.warn(`[flmux] invalid local extension catalog config: '${label}' must be an array in ${configPath}`);
    return [];
  }

  const selectors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      console.warn(
        `[flmux] invalid local extension catalog config: '${label}' entries must be non-empty strings in ${configPath}`
      );
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

async function validateSourceEntrypoint(
  runtimeRootDir: string,
  manifestPath: string,
  value: string | undefined,
  label: "renderer" | "cli" | "server"
): Promise<string | null> {
  if (typeof value !== "string") return null;

  const resolved = resolveExtensionRelativePath(runtimeRootDir, value);
  if (!resolved) {
    console.warn(`[flmux] invalid local extension ${label} entrypoint '${value}': ${manifestPath}`);
    return null;
  }
  if (!(await Bun.file(resolved).exists())) {
    console.warn(`[flmux] missing local extension ${label} entry: ${resolved}`);
    return null;
  }

  return toServedExtensionPath(value);
}

function validateArchiveEntrypoint(
  files: Map<string, File>,
  value: string | undefined,
  label: "renderer" | "cli" | "server",
  tarballPath: string
): string | null {
  if (typeof value !== "string") return null;

  const key = normalizeArchiveKey(value);
  if (!key) {
    console.warn(`[flmux] invalid ${label} entrypoint path in tarball manifest: ${value} (${tarballPath})`);
    return null;
  }
  if (!files.has(key)) {
    console.warn(`[flmux] tarball missing ${label} entry '${key}': ${tarballPath}`);
    return null;
  }

  return key;
}

/** Collapse to id-per-single-version. Same id, source wins over archive;
 * among archives with same id, highest version wins. */
function collapseById(entries: DiscoveredLocalExtension[]): DiscoveredLocalExtension[] {
  const byId = new Map<string, DiscoveredLocalExtension>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }

    if (existing.origin === "source" && entry.origin === "archive") {
      console.warn(`[flmux] extension '${entry.id}': source dir shadows tarball ${entry.originPath}`);
      continue;
    }
    if (existing.origin === "archive" && entry.origin === "source") {
      console.warn(
        `[flmux] extension '${entry.id}': source dir ${entry.originPath} shadows tarball ${existing.originPath}`
      );
      byId.set(entry.id, entry);
      continue;
    }

    // Both archive or both source → keep higher version.
    if (compareSemverLike(entry.version, existing.version) > 0) {
      console.warn(
        `[flmux] extension '${entry.id}': ${entry.originPath}@${entry.version} replaces ${existing.originPath}@${existing.version}`
      );
      byId.set(entry.id, entry);
    } else {
      console.warn(
        `[flmux] extension '${entry.id}': ${entry.originPath}@${entry.version} ignored (already at ${existing.version})`
      );
    }
  }
  return [...byId.values()];
}

function compareSemverLike(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function dedupePreservingOrder(values: string[]) {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
