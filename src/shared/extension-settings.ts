import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getFlmuxConfigDir } from "./paths";

interface ExtensionSettings {
  disabled: string[];
}

function getSettingsPath(): string {
  return join(getFlmuxConfigDir(), "extensions.json");
}

export function loadExtensionSettings(): ExtensionSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return { disabled: [] };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExtensionSettings>;
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((v) => typeof v === "string") : []
    };
  } catch {
    return { disabled: [] };
  }
}

export function saveExtensionSettings(settings: ExtensionSettings): void {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export function isExtensionDisabled(settings: ExtensionSettings, extensionId: string): boolean {
  return settings.disabled.includes(extensionId);
}

export function enableExtension(settings: ExtensionSettings, extensionId: string): ExtensionSettings {
  return {
    ...settings,
    disabled: settings.disabled.filter((id) => id !== extensionId)
  };
}

export function disableExtension(settings: ExtensionSettings, extensionId: string): ExtensionSettings {
  if (settings.disabled.includes(extensionId)) return settings;
  return {
    ...settings,
    disabled: [...settings.disabled, extensionId]
  };
}
