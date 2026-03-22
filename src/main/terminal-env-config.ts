import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TerminalHooksConfig {
  init: string[];
}

export function loadTerminalHooks(workspaceRoot: string): TerminalHooksConfig {
  const base = loadYaml(resolve(workspaceRoot, "flmux-hooks.yaml"));
  const dev = loadYaml(resolve(workspaceRoot, "flmux-hooks.dev.yaml"));
  return { init: [...base, ...dev] };
}

function loadYaml(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const doc = Bun.YAML.parse(raw) as { terminal?: { init?: unknown } } | null;
    const init = doc?.terminal?.init;
    if (!Array.isArray(init)) return [];
    return init.filter((v) => typeof v === "string").map((s) => s.trim());
  } catch {
    return [];
  }
}
