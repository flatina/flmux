import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { validateExtensionManifest, type ExtensionManifest } from "./manifest";

export interface ExtensionDirectoryValidationResult {
  ok: boolean;
  extensionDir: string;
  manifestPath: string;
  manifest?: ExtensionManifest;
  rendererEntryPath?: string;
  cliEntryPath?: string;
  serverEntryPath?: string;
  errors: string[];
}

export async function validateExtensionDirectory(extensionDir: string): Promise<ExtensionDirectoryValidationResult> {
  const manifestPath = join(extensionDir, "manifest.json");

  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      extensionDir,
      manifestPath,
      errors: [`Failed to read manifest.json: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch (error) {
    return {
      ok: false,
      extensionDir,
      manifestPath,
      errors: [`manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  const manifestResult = validateExtensionManifest(parsedManifest);
  if (!manifestResult.ok) {
    return {
      ok: false,
      extensionDir,
      manifestPath,
      errors: manifestResult.errors
    };
  }

  const manifest = manifestResult.manifest;
  const errors: string[] = [];
  const rendererEntryPath =
    typeof manifest.entrypoints.renderer === "string"
      ? resolveExtensionRelativePath(extensionDir, manifest.entrypoints.renderer)
      : undefined;
  const cliEntryPath =
    typeof manifest.entrypoints.cli === "string"
      ? resolveExtensionRelativePath(extensionDir, manifest.entrypoints.cli)
      : undefined;
  const serverEntryPath =
    typeof manifest.entrypoints.server === "string"
      ? resolveExtensionRelativePath(extensionDir, manifest.entrypoints.server)
      : undefined;

  if (manifest.entrypoints.renderer && !rendererEntryPath) {
    errors.push(`Renderer entrypoint '${manifest.entrypoints.renderer}' is invalid`);
  }
  if (manifest.entrypoints.cli && !cliEntryPath) {
    errors.push(`CLI entrypoint '${manifest.entrypoints.cli}' is invalid`);
  }
  if (manifest.entrypoints.server && !serverEntryPath) {
    errors.push(`Server entrypoint '${manifest.entrypoints.server}' is invalid`);
  }

  if (rendererEntryPath && !(await Bun.file(rendererEntryPath).exists())) {
    errors.push(`Renderer entrypoint does not exist: ${manifest.entrypoints.renderer}`);
  }
  if (cliEntryPath && !(await Bun.file(cliEntryPath).exists())) {
    errors.push(`CLI entrypoint does not exist: ${manifest.entrypoints.cli}`);
  }
  if (serverEntryPath && !(await Bun.file(serverEntryPath).exists())) {
    errors.push(`Server entrypoint does not exist: ${manifest.entrypoints.server}`);
  }

  return {
    ok: errors.length === 0,
    extensionDir,
    manifestPath,
    manifest,
    rendererEntryPath,
    cliEntryPath,
    serverEntryPath,
    errors
  };
}

export function resolveExtensionRelativePath(extensionDir: string, relativePath: string) {
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    return null;
  }

  const resolved = normalize(join(extensionDir, relativePath));
  const relativeToRoot = relative(extensionDir, resolved);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return null;
  }

  return resolved;
}

export function resolveValidateTargets(targets: string[]) {
  return targets.length > 0 ? targets : [process.cwd()];
}

export function formatExtensionValidationResult(result: ExtensionDirectoryValidationResult) {
  if (result.ok) {
    const details = [`OK  ${result.extensionDir}`, `  manifest: ${result.manifestPath}`];
    if (result.manifest?.entrypoints.renderer) {
      details.push(`  renderer: ${result.manifest.entrypoints.renderer}`);
    }
    if (result.manifest?.entrypoints.cli) {
      details.push(`  cli: ${result.manifest.entrypoints.cli}`);
    }
    if (result.manifest?.entrypoints.server) {
      details.push(`  server: ${result.manifest.entrypoints.server}`);
    }
    return details.join("\n");
  }

  return [`ERR ${result.extensionDir}`, ...result.errors.map((error) => `  - ${error}`)].join("\n");
}
