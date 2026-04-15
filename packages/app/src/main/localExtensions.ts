import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifest } from "@flmux/extension-api";
import type { FlmuxLocalExtensionSummary } from "../shared/rendererBridge";

export async function discoverLocalExtensionCatalog(rootDir: string): Promise<FlmuxLocalExtensionSummary[]> {
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
        try {
          const raw = await readFile(join(rootDir, entry.name, "manifest.json"), "utf8");
          const manifest = JSON.parse(raw) as Partial<ExtensionManifest>;
          if (
            typeof manifest.id !== "string" ||
            typeof manifest.name !== "string" ||
            typeof manifest.version !== "string"
          ) {
            console.warn(`[flmux] invalid extension manifest fields: ${join(rootDir, entry.name, "manifest.json")}`);
            return null;
          }

          return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version
          } satisfies FlmuxLocalExtensionSummary;
        } catch (error) {
          console.warn(
            `[flmux] failed to read extension manifest: ${join(rootDir, entry.name, "manifest.json")}`,
            error
          );
          return null;
        }
      })
  );

  return manifests
    .filter((manifest): manifest is FlmuxLocalExtensionSummary => manifest !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}
