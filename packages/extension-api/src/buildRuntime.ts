import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const extensionApiRuntimeTranspiler = new Bun.Transpiler({ loader: "ts" });
const _EXTENSION_API_RUNTIME_ROOT_URL = "/__flmux/runtime/extension-api.js";
const EXTENSION_API_RUNTIME_MODULE_PREFIX = "/__flmux/runtime/extension-api";

export interface ExtensionApiRuntimeBuildResult {
  ok: boolean;
  sourceDir: string;
  outDir: string;
  builtFiles: string[];
  errors: string[];
}

if (import.meta.main) {
  const result = await buildExtensionApiRuntime();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(`OK  ${result.outDir}`);
  console.log(`  files: ${result.builtFiles.length}`);
}

export async function buildExtensionApiRuntime(
  options: { sourceDir?: string; outDir?: string } = {}
): Promise<ExtensionApiRuntimeBuildResult> {
  const sourceDir = resolve(options.sourceDir ?? join(import.meta.dir, "."));
  const outDir = resolve(options.outDir ?? join(import.meta.dir, "..", "dist-runtime"));
  const builtFiles: string[] = [];

  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await buildRuntimeTree(sourceDir, outDir, builtFiles, sourceDir);
    return {
      ok: true,
      sourceDir,
      outDir,
      builtFiles,
      errors: []
    };
  } catch (error) {
    return {
      ok: false,
      sourceDir,
      outDir,
      builtFiles,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

async function buildRuntimeTree(sourceDir: string, outDir: string, builtFiles: string[], rootDir: string) {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await buildRuntimeTree(sourcePath, outDir, builtFiles, rootDir);
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }

    const relativePath = relative(rootDir, sourcePath);
    const targetPath = join(outDir, replaceTsExtension(relativePath));
    await mkdir(dirname(targetPath), { recursive: true });
    const source = await readFile(sourcePath, "utf8");
    const code = extensionApiRuntimeTranspiler.transformSync(
      rewriteRuntimeSourceImports(source, basename(sourcePath) === "index.ts")
    );
    await writeFile(targetPath, code, "utf8");
    builtFiles.push(targetPath);
  }
}

function rewriteRuntimeSourceImports(source: string, isRootEntry: boolean) {
  const relativeRewriter = isRootEntry
    ? (_match: string, prefix: string, moduleName: string, suffix: string) =>
        `${prefix}${EXTENSION_API_RUNTIME_MODULE_PREFIX}/${moduleName}.js${suffix}`
    : (_match: string, prefix: string, moduleName: string, suffix: string) => `${prefix}./${moduleName}.js${suffix}`;

  return source.replace(/((?:import|export)[\s\S]*?\sfrom\s+["'])\.\/([A-Za-z0-9_-]+)(["'])/g, relativeRewriter);
}

function replaceTsExtension(path: string) {
  return path.replace(/\.ts$/, ".js");
}
