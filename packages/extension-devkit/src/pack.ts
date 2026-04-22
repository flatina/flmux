import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { validateExtensionManifest, type ExtensionManifest } from "./manifest";

export interface ExtensionPackResult {
  ok: boolean;
  extensionDir: string;
  tarballPath: string;
  entryCount: number;
  errors: string[];
}

/**
 * Pack an already-built extension (`<extensionDir>/dist/`) into a gzip tarball
 * `<outDir>/<id>-<version>.tar.gz`. Archive entries are flat paths relative to
 * the extension's `dist/` root so `manifest.json` sits at the archive root.
 *
 * Uses Bun.Archive's native gzip compression — no external tar writer.
 */
export async function packExtensionDirectory(
  extensionDir: string,
  options: { outDir?: string } = {}
): Promise<ExtensionPackResult> {
  const resolvedExtensionDir = resolve(extensionDir);
  const distDir = join(resolvedExtensionDir, "dist");
  const manifestPath = join(distDir, "manifest.json");

  if (!(await Bun.file(manifestPath).exists())) {
    return {
      ok: false,
      extensionDir: resolvedExtensionDir,
      tarballPath: "",
      entryCount: 0,
      errors: [`No built manifest at ${manifestPath}. Run 'flmux-ext build' first.`]
    };
  }

  let manifest: ExtensionManifest;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = validateExtensionManifest(parsed);
    if (!result.ok) {
      return {
        ok: false,
        extensionDir: resolvedExtensionDir,
        tarballPath: "",
        entryCount: 0,
        errors: [`Invalid built manifest at ${manifestPath}:`, ...result.errors]
      };
    }
    manifest = result.manifest;
  } catch (error) {
    return {
      ok: false,
      extensionDir: resolvedExtensionDir,
      tarballPath: "",
      entryCount: 0,
      errors: [`Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  const outDir = options.outDir ? resolve(options.outDir) : dirname(resolvedExtensionDir);
  const tarballPath = join(outDir, `${manifest.id}-${manifest.version}.tar.gz`);

  const entries: Record<string, Uint8Array> = {};
  await collectDistFiles(distDir, distDir, entries);

  try {
    await Bun.Archive.write(tarballPath, entries, { compress: "gzip" });
  } catch (error) {
    return {
      ok: false,
      extensionDir: resolvedExtensionDir,
      tarballPath,
      entryCount: 0,
      errors: [`Failed to write tarball: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  return {
    ok: true,
    extensionDir: resolvedExtensionDir,
    tarballPath,
    entryCount: Object.keys(entries).length,
    errors: []
  };
}

export function formatExtensionPackResult(result: ExtensionPackResult): string {
  if (!result.ok) {
    return [`ERR ${result.extensionDir}`, ...result.errors.map((error) => `  - ${error}`)].join("\n");
  }

  return [`OK  ${result.extensionDir}`, `  tarball: ${result.tarballPath}`, `  entries: ${result.entryCount}`].join(
    "\n"
  );
}

async function collectDistFiles(dir: string, rootDir: string, entries: Record<string, Uint8Array>): Promise<void> {
  const dirEntries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of dirEntries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDistFiles(entryPath, rootDir, entries);
      continue;
    }

    // Archive uses forward slashes regardless of host OS (tar convention; also
    // what Bun.Archive.files() returns on read).
    const archivePath = relative(rootDir, entryPath).replace(/\\/g, "/");
    entries[archivePath] = new Uint8Array(await Bun.file(entryPath).arrayBuffer());
  }
}
