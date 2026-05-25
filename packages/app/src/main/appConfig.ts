import { existsSync, readFileSync } from "node:fs";

/**
 * Read `[app] title` from the app config file (typically `<flmuxDir>/app.toml`).
 * Returns undefined when the file is absent, malformed, or has no app.title —
 * caller falls back to whatever default ShellCore carries. Used for "fresh
 * install with desired title" deployment scenario; runtime mutations still
 * persist via session.json and override the config on subsequent boots.
 */
export function resolveFlmuxAppTitle(configFile: string | null | undefined): string | undefined {
  return readAppStringKey(configFile, "title");
}

export function resolveFlmuxAppName(configFile: string | null | undefined): string | undefined {
  return readAppStringKey(configFile, "name");
}

function readAppStringKey(configFile: string | null | undefined, key: "title" | "name"): string | undefined {
  if (!configFile || !existsSync(configFile)) return undefined;
  try {
    const raw = readFileSync(configFile, "utf8");
    const parsed = Bun.TOML.parse(raw) as { app?: Record<string, unknown> };
    const value = parsed.app?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
