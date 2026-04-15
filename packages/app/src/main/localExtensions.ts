import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { validateExtensionManifest, type ExtensionManifest } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../shared/rendererBridge";

export interface DiscoveredLocalExtension {
  id: string;
  name: string;
  version: string;
  manifest: ExtensionManifest;
  rootDir: string;
  manifestPath: string;
  rendererEntryPath: string | null;
  cliEntryPath: string | null;
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
          const manifestResult = validateExtensionManifest(JSON.parse(raw));
          if (!manifestResult.ok) {
            console.warn(
              `[flmux] invalid extension manifest: ${manifestPath}\n- ${manifestResult.errors.join("\n- ")}`
            );
            return null;
          }
          const manifest = manifestResult.manifest;

          const rendererEntryPath = await resolveValidatedEntrypoint({
            extensionRootDir,
            manifestPath,
            value: manifest.entrypoints.renderer,
            label: "renderer"
          });
          const cliEntryPath = await resolveValidatedEntrypoint({
            extensionRootDir,
            manifestPath,
            value: manifest.entrypoints.cli,
            label: "cli"
          });

          if (!rendererEntryPath && !cliEntryPath) {
            console.warn(`[flmux] local extension has no usable renderer or cli entrypoint: ${manifestPath}`);
            return null;
          }

          return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            manifest: manifest as ExtensionManifest,
            rootDir: extensionRootDir,
            manifestPath,
            rendererEntryPath,
            cliEntryPath
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
  return extensions
    .filter((extension) => extension.rendererEntryPath !== null)
    .map((extension) => {
      const baseUrl = `${appOrigin}/__flmux/ext/${encodeURIComponent(extension.id)}/${encodeURIComponent(extension.version)}`;
      const rendererEntrypoint = extension.manifest.entrypoints.renderer!;
      return {
        id: extension.id,
        name: extension.name,
        version: extension.version,
        manifestUrl: `${baseUrl}/manifest.json`,
        rendererEntryUrl: `${baseUrl}/${toServedExtensionPath(rendererEntrypoint)}`
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
