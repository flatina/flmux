declare const process:
  | {
      env: Record<string, string | undefined>;
      platform?: string;
    }
  | undefined;

const APP_DIR_NAME = "flmux";

function getRuntimePlatform(): string | undefined {
  return typeof process === "undefined" ? undefined : process.platform;
}

function getEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

function getPathSeparator(): string {
  return getRuntimePlatform() === "win32" ? "\\" : "/";
}

function trimLeadingSeparators(value: string): string {
  return value.replace(/^[\\/]+/g, "");
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

function joinPath(...parts: Array<string | null | undefined>): string {
  const separator = getPathSeparator();
  const filtered = parts.filter((part): part is string => Boolean(part));

  if (filtered.length === 0) {
    return "";
  }

  return filtered
    .map((part, index) => {
      if (index === 0) {
        return trimTrailingSeparators(part);
      }

      return trimTrailingSeparators(trimLeadingSeparators(part));
    })
    .filter((part) => part.length > 0)
    .join(separator);
}

function getHomeDir(): string {
  if (getRuntimePlatform() === "win32") {
    return getEnv("USERPROFILE")
      ?? (getEnv("HOMEDRIVE") && getEnv("HOMEPATH") ? `${getEnv("HOMEDRIVE")}${getEnv("HOMEPATH")}` : null)
      ?? getEnv("HOME")
      ?? "C:\\Users\\Default";
  }

  return getEnv("HOME") ?? "/root";
}

// ── XDG base directories ──

/** $XDG_CONFIG_HOME/flmux — user-editable config (extensions.json, ui-settings.json) */
export function getFlmuxConfigDir(): string {
  const xdg = getEnv("XDG_CONFIG_HOME");
  return joinPath(xdg || joinPath(getHomeDir(), ".config"), APP_DIR_NAME);
}

/** $XDG_DATA_HOME/flmux — app-managed data (extensions/, sessions/) */
export function getFlmuxDataDir(): string {
  const xdg = getEnv("XDG_DATA_HOME");
  return joinPath(xdg || joinPath(getHomeDir(), ".local", "share"), APP_DIR_NAME);
}

/** $XDG_STATE_HOME/flmux — ephemeral state (flmux-last.json) */
export function getFlmuxStateDir(): string {
  const xdg = getEnv("XDG_STATE_HOME");
  return joinPath(xdg || joinPath(getHomeDir(), ".local", "state"), APP_DIR_NAME);
}

// ── Concrete paths ──

export function getFlmuxLastPath(): string {
  return joinPath(getFlmuxStateDir(), "flmux-last.json");
}

export function getSessionDir(): string {
  return joinPath(getFlmuxDataDir(), "sessions");
}

export function getExtensionsDir(): string {
  return joinPath(getFlmuxDataDir(), "extensions");
}
