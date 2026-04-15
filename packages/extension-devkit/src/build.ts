import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ExtensionManifest } from "../../extension-api/src/manifest";
import { validateExtensionDirectory } from "./validate";

const extensionBuildTranspiler = new Bun.Transpiler({ loader: "ts" });
const EXTENSION_API_RUNTIME_URL = "/__flmux/runtime/extension-api.js";

export interface ExtensionBuildResult {
  ok: boolean;
  extensionDir: string;
  outDir: string;
  manifestPath: string;
  builtFiles: string[];
  errors: string[];
}

export async function buildExtensionDirectory(extensionDir: string): Promise<ExtensionBuildResult> {
  const resolvedExtensionDir = resolve(extensionDir);
  const validation = await validateExtensionDirectory(resolvedExtensionDir);
  const outDir = join(resolvedExtensionDir, "dist");

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

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const builtFiles: string[] = [];
  await buildExtensionTree(extensionDir, outDir, builtFiles);

  const runtimeManifest = createRuntimeManifest(validation.manifest);
  const manifestPath = join(outDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(runtimeManifest, null, 2), "utf8");
  builtFiles.push(manifestPath);

  return {
    ok: true,
    extensionDir: resolvedExtensionDir,
    outDir,
    manifestPath,
    builtFiles,
    errors: []
  };
}

export function formatExtensionBuildResult(result: ExtensionBuildResult) {
  if (!result.ok) {
    return [
      `ERR ${result.extensionDir}`,
      ...result.errors.map((error) => `  - ${error}`)
    ].join("\n");
  }

  return [
    `OK  ${result.extensionDir}`,
    `  outDir: ${result.outDir}`,
    `  manifest: ${result.manifestPath}`,
    `  files: ${result.builtFiles.length}`
  ].join("\n");
}

async function buildExtensionTree(
  sourceDir: string,
  outDir: string,
  builtFiles: string[],
  rootDir: string = sourceDir
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    if (sourceDir === rootDir && (entry.name === "manifest.json" || entry.name === "package.json")) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const relativePath = relative(rootDir, sourcePath);
    if (entry.isDirectory()) {
      await buildExtensionTree(sourcePath, outDir, builtFiles, rootDir);
      continue;
    }

    if (entry.name.endsWith(".ts")) {
      const targetPath = join(outDir, replaceTsExtension(relativePath));
      await mkdir(dirname(targetPath), { recursive: true });
      const source = await readFile(sourcePath, "utf8");
      const code = extensionBuildTranspiler.transformSync(rewriteTypeScriptModuleImports(source));
      await writeFile(targetPath, code, "utf8");
      builtFiles.push(targetPath);
      continue;
    }

    const targetPath = join(outDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, Bun.file(sourcePath));
    builtFiles.push(targetPath);
  }
}

function createRuntimeManifest(sourceManifest: ExtensionManifest): ExtensionManifest {
  return {
    ...sourceManifest,
    entrypoints: {
      renderer: sourceManifest.entrypoints.renderer ? replaceTsExtension(stripRelativePrefix(sourceManifest.entrypoints.renderer)) : undefined,
      cli: sourceManifest.entrypoints.cli ? replaceTsExtension(stripRelativePrefix(sourceManifest.entrypoints.cli)) : undefined
    }
  };
}

function rewriteTypeScriptModuleImports(source: string) {
  return source
    .replace(
      /((?:import|export)[\s\S]*?\sfrom\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) => `${prefix}${rewriteRelativeSpecifier(specifier)}${suffix}`
    )
    .replace(
      /(import\(\s*["'])(\.{1,2}\/[^"']+?)(["']\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) => `${prefix}${rewriteRelativeSpecifier(specifier)}${suffix}`
    )
    .replace(
      /(import\s+(?!type\b)[\s\S]*?\sfrom\s+)["']@flmux\/extension-api["']/g,
      `$1"${EXTENSION_API_RUNTIME_URL}"`
    )
    .replace(
      /(export[\s\S]*?\sfrom\s+)["']@flmux\/extension-api["']/g,
      `$1"${EXTENSION_API_RUNTIME_URL}"`
    )
    .replace(/import\(\s*["']@flmux\/extension-api["']\s*\)/g, `import("${EXTENSION_API_RUNTIME_URL}")`);
}

function rewriteRelativeSpecifier(specifier: string) {
  return specifier.endsWith(".ts") ? replaceTsExtension(specifier) : specifier;
}

function replaceTsExtension(path: string) {
  return path.replace(/\.ts$/, ".js");
}

function stripRelativePrefix(path: string) {
  return path.replace(/^\.\/+/, "");
}
