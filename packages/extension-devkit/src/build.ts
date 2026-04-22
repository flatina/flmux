import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionManifest } from "../../extension-api/src/manifest";
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

const SKIP_DIRS = new Set(["node_modules", "dist", "dist.tmp"]);
const SKIP_ROOT_FILES = new Set(["manifest.json", "package.json", "tsconfig.json"]);

/**
 * Build an extension directory into `<extensionDir>/dist/`.
 *
 * Contract ({@link internal notes}):
 * - Each entrypoint (renderer/cli/server) bundles to a single-file ESM.
 * - `@flmux/extension-api` stays external (renderer importmap resolves it;
 *   cli/server never import it at runtime — types only).
 * - Writes to `dist.tmp/` then renames atomically so a failed rebuild leaves
 *   the previous `dist/` intact.
 */
export async function buildExtensionDirectory(extensionDir: string): Promise<ExtensionBuildResult> {
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
      const bundleResult = await bundleEntrypoint(entry, tmpDir);
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

  // Re-map built file paths from tmp → final.
  const finalBuiltFiles = builtFiles.map((p) => p.replace(tmpDir, outDir));

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
  tmpDir: string
): Promise<{ ok: true; builtFiles: string[] } | { ok: false; errors: string[] }> {
  const outPath = join(tmpDir, replaceTsExtension(stripRelativePrefix(entry.sourceRelative)));
  await mkdir(dirname(outPath), { recursive: true });

  // Renderer runs in the browser; CEF preload's importmap resolves
  // `@flmux/extension-api` and its subpaths to `/__flmux/runtime/extension-api*.js`,
  // so they stay external. CLI/server run in Bun; they import only types
  // from `@flmux/extension-api` (zero runtime deps by contract), so keeping
  // the same external list is safe and keeps bundle output identical across
  // entrypoint kinds.
  const external = ["@flmux/extension-api", "@flmux/extension-api/*"];
  const target = entry.kind === "renderer" ? "browser" : "bun";

  const result = await Bun.build({
    entrypoints: [entry.sourcePath],
    target,
    format: "esm",
    external,
    // Keep outputs readable for dev; pack/size pressure doesn't apply here.
    minify: false,
    sourcemap: "none"
  });

  if (!result.success) {
    return {
      ok: false,
      errors: result.logs.map((log) => `[${entry.kind}] ${entry.sourceRelative}: ${String(log)}`)
    };
  }

  const output = result.outputs[0];
  if (!output) {
    return { ok: false, errors: [`[${entry.kind}] bundler produced no output for ${entry.sourceRelative}`] };
  }

  await writeFile(outPath, await output.text(), "utf8");
  return { ok: true, builtFiles: [outPath] };
}

async function copyStaticAssets(sourceDir: string, tmpDir: string, builtFiles: string[]): Promise<void> {
  await copyStaticAssetsRecursive(sourceDir, tmpDir, builtFiles, sourceDir);
}

async function copyStaticAssetsRecursive(
  sourceDir: string,
  tmpDir: string,
  builtFiles: string[],
  rootDir: string
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    // Root-level JSON/config files aren't copied — manifest.json is rewritten
    // separately, and package.json/tsconfig.json are dev-only.
    if (sourceDir === rootDir && SKIP_ROOT_FILES.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await copyStaticAssetsRecursive(sourcePath, tmpDir, builtFiles, rootDir);
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
