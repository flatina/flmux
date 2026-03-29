import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceRoot } from "../../lib/runtime-paths";

import type { LogLevel } from "../../lib/logger";
export type { LogLevel } from "../../lib/logger";

export interface FlmuxConfig {
  app: {
    restoreLayout: boolean;
  };
  log: {
    level: LogLevel;
  };
  web: {
    enabled: boolean;
    host: string;
    port: number;
  };
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

export function getDefaultConfig(isDev: boolean): FlmuxConfig {
  return {
    app: {
      restoreLayout: false
    },
    log: {
      level: isDev ? "debug" : "info"
    },
    web: {
      enabled: false,
      host: "127.0.0.1",
      port: 3000
    }
  };
}

export function mergeConfig(defaults: FlmuxConfig, parsed: Record<string, unknown>): FlmuxConfig {
  const app = typeof parsed.app === "object" && parsed.app ? (parsed.app as Record<string, unknown>) : {};
  const log = typeof parsed.log === "object" && parsed.log ? (parsed.log as Record<string, unknown>) : {};
  const web = typeof parsed.web === "object" && parsed.web ? (parsed.web as Record<string, unknown>) : {};

  return {
    app: {
      restoreLayout: typeof app.restoreLayout === "boolean" ? app.restoreLayout : defaults.app.restoreLayout
    },
    log: {
      level: isLogLevel(log.level) ? log.level : defaults.log.level
    },
    web: {
      enabled: typeof web.enabled === "boolean" ? web.enabled : defaults.web.enabled,
      host: typeof web.host === "string" ? web.host : defaults.web.host,
      port: typeof web.port === "number" ? web.port : defaults.web.port
    }
  };
}

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
