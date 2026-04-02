import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceRoot } from "../../lib/runtime-paths";

export type ExtensionConfigMap = Record<string, Record<string, unknown>>;

export function loadExtensionConfig(): ExtensionConfigMap {
  const root = resolveWorkspaceRoot() ?? process.cwd();
  const configPath = join(root, "flmux-ext.toml");

  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    const result: ExtensionConfigMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        result[key] = value as Record<string, unknown>;
      }
    }
    return result;
  } catch {
    return {};
  }
}
