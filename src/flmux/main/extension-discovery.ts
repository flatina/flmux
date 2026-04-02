import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { ExtensionSetupModule } from "../model/bootstrap-state";
import { resolveEmbeddedExtensionRoot } from "../../lib/runtime-paths";

// Re-export discovery from config/ for existing main/ consumers
export type { DiscoveredExtension } from "../config/extension-discovery";
export { discoverExtensions, discoverAllExtensions, EXTENSION_ID_PATTERN } from "../config/extension-discovery";
import type { DiscoveredExtension } from "../config/extension-discovery";

const rendererSourceCache = new Map<string, string>();

export async function buildExtensionSetups(extensions: DiscoveredExtension[]): Promise<ExtensionSetupModule[]> {
  return Promise.all(
    extensions.map(async (ext) => ({
      id: ext.manifest.id,
      source: await loadSetupSource(ext)
    }))
  );
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

async function loadSetupSource(ext: DiscoveredExtension): Promise<string | undefined> {
  const entry = ext.manifest.rendererSetupEntry;
  if (!entry) return undefined;

  if (!entry.startsWith("./") || entry.includes("..")) return undefined;
  const resolvedEntry = resolve(ext.path, entry);
  if (!resolvedEntry.startsWith(resolve(ext.path))) return undefined;

  // Plain JS — read directly, no bundling needed
  if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) {
    const result = readExtensionTextFile(ext, entry, "rendererSetupEntry");
    return result.ok ? result.content : undefined;
  }

  try {
    const outdir = join(tmpdir(), "flmux-ext-setup-bundles", ext.manifest.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
    const sdkEntry = resolveFlmuxSdkEntry(resolveEmbeddedExtensionRoot() ?? process.cwd());
    const result = await Bun.build({
      entrypoints: [resolvedEntry],
      outdir,
      target: "browser",
      format: "esm",
      splitting: false,
      minify: false,
      sourcemap: "inline",
      plugins: [createFlmuxSdkAliasPlugin(sdkEntry)]
    });
    if (!result.success || result.outputs.length === 0) return undefined;
    return readFileSync(result.outputs[0]!.path, "utf-8");
  } catch {
    return undefined;
  }
}

export async function loadExtensionText(
  extensions: DiscoveredExtension[],
  params:
    | { extensionId: string; kind: "renderer" }
    | { extensionId: string; kind: "asset"; path: string }
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { extensionId } = params;
  const ext = extensions.find((e) => e.manifest.id === extensionId);
  if (!ext) {
    return { ok: false, error: `Extension not found: ${extensionId}` };
  }

  if (params.kind === "asset") {
    return readExtensionTextFile(ext, params.path, "asset");
  }

  const entry = ext.manifest.rendererEntry;
  if (!entry) {
    return { ok: false, error: `Extension has no rendererEntry: ${extensionId}` };
  }

  const text = readExtensionTextFile(ext, entry, "rendererEntry");
  if (!text.ok) return text;
  if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
    return { ok: true, content: text.content };
  }
  const resolvedEntry = resolve(ext.path, entry);
  const cacheKey = `${ext.manifest.id}:${resolvedEntry}`;
  const cached = rendererSourceCache.get(cacheKey);
  if (cached) {
    return { ok: true, content: cached };
  }

  try {
    const outdir = join(tmpdir(), "flmux-ext-bundles", ext.manifest.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
    const sdkEntry = resolveFlmuxSdkEntry(resolveEmbeddedExtensionRoot() ?? process.cwd());
    const result = await Bun.build({
      entrypoints: [resolvedEntry],
      outdir,
      target: "browser",
      format: "esm",
      splitting: false,
      minify: false,
      sourcemap: "inline",
      plugins: [createFlmuxSdkAliasPlugin(sdkEntry)]
    });
    if (!result.success || result.outputs.length === 0) {
      const log = result.logs[0];
      return { ok: false, error: `Failed to bundle extension source: ${log ? String(log) : "unknown error"}` };
    }
    const content = readFileSync(result.outputs[0]!.path, "utf-8");
    rendererSourceCache.set(cacheKey, content);
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `Failed to read extension source: ${err}` };
  }
}

function resolveFlmuxSdkEntry(root: string): string {
  const candidates = [
    resolve(root, "packages", "flmux-sdk", "index.ts"),
    resolve(root, "node_modules", "flmux-sdk", "index.ts")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function createFlmuxSdkAliasPlugin(sdkEntry: string): BunPlugin {
  return {
    name: "flmux-sdk-alias",
    setup(build) {
      build.onResolve({ filter: /^flmux-sdk$/ }, () => ({ path: sdkEntry }));
    }
  };
}
