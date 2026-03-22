import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FlmuxConfig, getDefaultConfig, mergeConfig } from "../shared/config";
import { resolveWorkspaceRoot } from "./runtime-paths";

export function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function loadConfig(): FlmuxConfig {
  const defaults = getDefaultConfig(isDev());
  const root = resolveWorkspaceRoot() ?? process.cwd();
  const configPath = join(root, "flmux.toml");

  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    return mergeConfig(defaults, parsed);
  } catch {
    return defaults;
  }
}
