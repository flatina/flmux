import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getFlmuxDataDir } from "./paths";

export type UiTheme = "system" | "dark" | "light";

interface UiSettings {
  theme: UiTheme;
}

const VALID_THEMES: readonly string[] = ["system", "dark", "light"];

function getSettingsPath(): string {
  return join(getFlmuxDataDir(), "ui-settings.json");
}

export function loadUiSettings(): UiSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return { theme: "system" };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const theme =
      typeof parsed.theme === "string" && VALID_THEMES.includes(parsed.theme)
        ? (parsed.theme as UiTheme)
        : "system";
    return { theme };
  } catch {
    return { theme: "system" };
  }
}

export function saveUiTheme(theme: UiTheme): void {
  if (!VALID_THEMES.includes(theme)) return;
  const settings = loadUiSettings();
  settings.theme = theme;
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}
