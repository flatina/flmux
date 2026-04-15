import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { FLMUX_EXTENSION_API_VERSION, type ExtensionManifest } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../shared/rendererBridge";

export interface DiscoveredLocalExtension {
  id: string;
  name: string;
  version: string;
  manifest: ExtensionManifest;
  rootDir: string;
  manifestPath: string;
  rendererEntryPath: string;
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
        const manifestPath = join(extensionRootDir, "manifest.json");

        try {
          const raw = await readFile(manifestPath, "utf8");
          const manifest = JSON.parse(raw) as Partial<ExtensionManifest>;
          if (
            typeof manifest.id !== "string" ||
            typeof manifest.name !== "string" ||
            typeof manifest.version !== "string" ||
            typeof manifest.apiVersion !== "number" ||
            !isPlainObject(manifest.entrypoints)
          ) {
            console.warn(`[flmux] invalid extension manifest fields: ${manifestPath}`);
            return null;
          }

          if (manifest.apiVersion !== FLMUX_EXTENSION_API_VERSION) {
            console.warn(
              `[flmux] unsupported extension apiVersion ${manifest.apiVersion} in: ${manifestPath}`
            );
            return null;
          }

          if (typeof manifest.entrypoints.renderer !== "string") {
            console.warn(`[flmux] missing local extension renderer entrypoint: ${manifestPath}`);
            return null;
          }

          const rendererEntryPath = resolveExtensionRelativePath(extensionRootDir, manifest.entrypoints.renderer);
          if (!rendererEntryPath) {
            console.warn(
              `[flmux] invalid local extension renderer entrypoint '${manifest.entrypoints.renderer}': ${manifestPath}`
            );
            return null;
          }

          if (!(await Bun.file(rendererEntryPath).exists())) {
            console.warn(`[flmux] missing local extension renderer entry: ${rendererEntryPath}`);
            return null;
          }

          return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            manifest: manifest as ExtensionManifest,
            rootDir: extensionRootDir,
            manifestPath,
            rendererEntryPath
          } satisfies DiscoveredLocalExtension;
        } catch (error) {
          console.warn(
            `[flmux] failed to read extension manifest: ${manifestPath}`,
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

export function createLocalExtensionLoadEntries(
  extensions: DiscoveredLocalExtension[],
  appOrigin: string
): FlmuxLocalExtensionLoadEntry[] {
  return extensions.map((extension) => {
    const baseUrl = `${appOrigin}/__flmux/ext/${encodeURIComponent(extension.id)}/${encodeURIComponent(extension.version)}`;
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      manifestUrl: `${baseUrl}/manifest.json`,
      rendererEntryUrl: `${baseUrl}/renderer.js`
    } satisfies FlmuxLocalExtensionLoadEntry;
  });
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
