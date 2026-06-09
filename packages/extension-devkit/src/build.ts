import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { compileIgnore } from "./ignore";
import type { ExtensionManifest } from "./manifest";
import { validateExtensionDirectory } from "./validate";

export interface ExtensionBuildResult {
  ok: boolean;
  extensionDir: string;
  outDir: string;
  manifestPath: string;
  builtFiles: string[];
  errors: string[];
}

interface EntrypointSpec {
  kind: "renderer" | "cli" | "server";
  sourcePath: string;
  sourceRelative: string;
}

const SHIP_IGNORE_FILE = ".flmux-ext-ignore";
const SKIP_DIRS = new Set(["node_modules", "dist", "dist.tmp"]);
const SKIP_ROOT_FILES = new Set(["manifest.json", "package.json", "tsconfig.json", SHIP_IGNORE_FILE]);

/**
 * Build an extension directory into `<extensionDir>/dist/`.
 *
 * Contract:
 * - Each entrypoint (renderer/cli/server) bundles to a single-file ESM.
 * - `@flmux/extension-api` stays external (renderer importmap resolves it;
 *   cli/server never import it at runtime — types only).
 * - Writes to `dist.tmp/` then renames atomically so a failed rebuild leaves
 *   the previous `dist/` intact.
 */
export async function buildExtensionDirectory(
  extensionDir: string,
  options: { minify?: boolean } = {}
): Promise<ExtensionBuildResult> {
  const resolvedExtensionDir = resolve(extensionDir);
  const validation = await validateExtensionDirectory(resolvedExtensionDir);
  const outDir = join(resolvedExtensionDir, "dist");
  const tmpDir = join(resolvedExtensionDir, "dist.tmp");

  if (!validation.ok || !validation.manifest) {
    return {
      ok: false,
      extensionDir: resolvedExtensionDir,
      outDir,
      manifestPath: join(outDir, "manifest.json"),
      builtFiles: [],
      errors: validation.errors
    };
  }

  const entrypoints: EntrypointSpec[] = [];
  if (validation.manifest.entrypoints.renderer && validation.rendererEntryPath) {
    entrypoints.push({
      kind: "renderer",
      sourcePath: validation.rendererEntryPath,
      sourceRelative: validation.manifest.entrypoints.renderer
    });
  }
  if (validation.manifest.entrypoints.cli && validation.cliEntryPath) {
    entrypoints.push({
      kind: "cli",
      sourcePath: validation.cliEntryPath,
      sourceRelative: validation.manifest.entrypoints.cli
    });
  }
  if (validation.manifest.entrypoints.server && validation.serverEntryPath) {
    entrypoints.push({
      kind: "server",
      sourcePath: validation.serverEntryPath,
      sourceRelative: validation.manifest.entrypoints.server
    });
  }

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const builtFiles: string[] = [];
  const errors: string[] = [];

  try {
    await copyStaticAssets(resolvedExtensionDir, tmpDir, builtFiles);

    for (const entry of entrypoints) {
      const bundleResult = await bundleEntrypoint(entry, tmpDir, options.minify ?? false);
      if (!bundleResult.ok) {
        errors.push(...bundleResult.errors);
        continue;
      }
      builtFiles.push(...bundleResult.builtFiles);
    }

    if (errors.length > 0) {
      await rm(tmpDir, { recursive: true, force: true });
      return {
        ok: false,
        extensionDir: resolvedExtensionDir,
        outDir,
        manifestPath: join(outDir, "manifest.json"),
        builtFiles: [],
        errors
      };
    }

    const runtimeManifest = createRuntimeManifest(validation.manifest);
    const manifestPath = join(tmpDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(runtimeManifest, null, 2), "utf8");
    builtFiles.push(manifestPath);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      extensionDir: resolvedExtensionDir,
      outDir,
      manifestPath: join(outDir, "manifest.json"),
      builtFiles: [],
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }

  // Atomic swap: remove old dist, rename tmp → dist. Windows requires the
  // target to not exist before rename.
  await rm(outDir, { recursive: true, force: true });
  await rename(tmpDir, outDir);

  // Re-map built file paths from tmp → final. Use slice instead of replace so
  // a `$&`/`$1` sequence in a user path would never be interpreted.
  const finalBuiltFiles = builtFiles.map((p) => (p.startsWith(tmpDir) ? outDir + p.slice(tmpDir.length) : p));

  return {
    ok: true,
    extensionDir: resolvedExtensionDir,
    outDir,
    manifestPath: join(outDir, "manifest.json"),
    builtFiles: finalBuiltFiles,
    errors: []
  };
}

export function formatExtensionBuildResult(result: ExtensionBuildResult) {
  if (!result.ok) {
    return [`ERR ${result.extensionDir}`, ...result.errors.map((error) => `  - ${error}`)].join("\n");
  }

  return [
    `OK  ${result.extensionDir}`,
    `  outDir: ${result.outDir}`,
    `  manifest: ${result.manifestPath}`,
    `  files: ${result.builtFiles.length}`
  ].join("\n");
}

async function bundleEntrypoint(
  entry: EntrypointSpec,
  tmpDir: string,
  minify: boolean
): Promise<{ ok: true; builtFiles: string[] } | { ok: false; errors: string[] }> {
  const outPath = join(tmpDir, replaceTsExtension(stripRelativePrefix(entry.sourceRelative)));
  await mkdir(dirname(outPath), { recursive: true });

  // All entries are self-contained — `@flmux/extension-api` (types + tiny
  // identity helpers like defineExtension/definePane) is inlined rather than
  // left bare. Reason: main-side `import()` of archive-backed renderer
  // bundles runs from a `data:` URL, which has no resolution base for bare
  // specifiers. Inlining makes every entry loadable in every context (CEF
  // via HTTP, main via data URL).
  const target = entry.kind === "renderer" ? "browser" : "bun";

  const result = await Bun.build({
    entrypoints: [entry.sourcePath],
    target,
    format: "esm",
    // Dev builds stay readable; production (deploy / --minify) mangles + dead-codes.
    minify,
    // sourcemap stays off even when minified — shipping one would undo the minify.
    sourcemap: "none"
  });

  if (!result.success) {
    return {
      ok: false,
      errors: result.logs.map((log) => `[${entry.kind}] ${entry.sourceRelative}: ${String(log)}`)
    };
  }

  if (result.outputs.length === 0) {
    return { ok: false, errors: [`[${entry.kind}] bundler produced no output for ${entry.sourceRelative}`] };
  }

  // The primary entry is outputs[0]; sidecars (CSS, worker chunks, etc.) land
  // in subsequent outputs with their own paths rooted at the bundler's outdir.
  // Persist every output so bundled assets reach dist/ and the tarball.
  const built: string[] = [];
  const outDir = dirname(outPath);
  for (const [index, artifact] of result.outputs.entries()) {
    const artifactPath = index === 0 ? outPath : join(outDir, artifact.path.replace(/^\.\//, ""));
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, new Uint8Array(await artifact.arrayBuffer()));
    built.push(artifactPath);
  }
  return { ok: true, builtFiles: built };
}

async function copyStaticAssets(sourceDir: string, tmpDir: string, builtFiles: string[]): Promise<void> {
  await copyStaticAssetsRecursive(sourceDir, tmpDir, builtFiles, sourceDir, await loadShipIgnore(sourceDir));
}

// Author-controlled ship-exclusion (`.flmux-ext-ignore`, gitignore-style subset).
// Absent → null (copy everything, as before — no regression).
async function loadShipIgnore(rootDir: string): Promise<((relPath: string, isDir: boolean) => boolean) | null> {
  try {
    return compileIgnore(await readFile(join(rootDir, SHIP_IGNORE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function copyStaticAssetsRecursive(
  sourceDir: string,
  tmpDir: string,
  builtFiles: string[],
  rootDir: string,
  ignore: ((relPath: string, isDir: boolean) => boolean) | null
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    // Root-level JSON/config files aren't copied — manifest.json is rewritten
    // separately, and package.json/tsconfig.json (+ the ignore file) are dev-only.
    if (sourceDir === rootDir && SKIP_ROOT_FILES.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    // Author opt-out: skip the entry (and, for a directory, its whole subtree).
    if (ignore?.(relative(rootDir, sourcePath), entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyStaticAssetsRecursive(sourcePath, tmpDir, builtFiles, rootDir, ignore);
      continue;
    }

    // Skip TS sources — they're handled by the bundler, not copied raw.
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      continue;
    }

    const relativePath = relative(rootDir, sourcePath);
    const targetPath = join(tmpDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, Bun.file(sourcePath));
    builtFiles.push(targetPath);
  }
}

function createRuntimeManifest(sourceManifest: ExtensionManifest): ExtensionManifest {
  return {
    ...sourceManifest,
    entrypoints: {
      renderer: sourceManifest.entrypoints.renderer
        ? replaceTsExtension(stripRelativePrefix(sourceManifest.entrypoints.renderer))
        : undefined,
      cli: sourceManifest.entrypoints.cli
        ? replaceTsExtension(stripRelativePrefix(sourceManifest.entrypoints.cli))
        : undefined,
      server: sourceManifest.entrypoints.server
        ? replaceTsExtension(stripRelativePrefix(sourceManifest.entrypoints.server))
        : undefined
    }
  };
}

function replaceTsExtension(path: string) {
  return path.replace(/\.tsx?$/, ".js");
}

function stripRelativePrefix(path: string) {
  return path.replace(/^\.\/+/, "");
}
