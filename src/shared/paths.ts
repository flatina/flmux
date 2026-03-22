import type { SessionId } from "./ids";

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
  const userProfile = getEnv("USERPROFILE");
  if (userProfile) {
    return userProfile;
  }

  const homeDrive = getEnv("HOMEDRIVE");
  const homePath = getEnv("HOMEPATH");
  if (homeDrive && homePath) {
    return `${homeDrive}${homePath}`;
  }

  return getEnv("HOME") ?? "~";
}

export function getFlmuxDataDir(): string {
  const override = getEnv("FLMUX_DATA_DIR");
  if (override) {
    return override;
  }

  return joinPath(getHomeDir(), ".config", APP_DIR_NAME);
}

export function getFlmuxLastPath(): string {
  return joinPath(getFlmuxDataDir(), "flmux-last.json");
}

export function getSessionDir(): string {
  return joinPath(getFlmuxDataDir(), "sessions");
}

export function getSessionRecordPath(sessionId: SessionId | string): string {
  return joinPath(getSessionDir(), `${sessionId}.json`);
}

export function getExtensionsDir(): string {
  return joinPath(getFlmuxDataDir(), "extensions");
}

export function getBrowserCtlRefsPath(): string {
  return joinPath(getFlmuxDataDir(), "browser-ctl-refs.json");
}
