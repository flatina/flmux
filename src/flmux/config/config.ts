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
  terminal: {
    path: string[];
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
    terminal: {
      path: []
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
  const terminal = typeof parsed.terminal === "object" && parsed.terminal ? (parsed.terminal as Record<string, unknown>) : {};
  const web = typeof parsed.web === "object" && parsed.web ? (parsed.web as Record<string, unknown>) : {};

  return {
    app: {
      restoreLayout: typeof app.restoreLayout === "boolean" ? app.restoreLayout : defaults.app.restoreLayout
    },
    log: {
      level: isLogLevel(log.level) ? log.level : defaults.log.level
    },
    terminal: {
      path: Array.isArray(terminal.path)
        ? terminal.path.filter((p): p is string => typeof p === "string")
        : defaults.terminal.path
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

function loadToml(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return Bun.TOML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function loadConfig(): FlmuxConfig {
  const defaults = getDefaultConfig(isDev());
  const root = resolveWorkspaceRoot() ?? process.cwd();

  // Base config
  let config = defaults;
  const base = loadToml(join(root, "flmux.toml"));
  if (base) {
    config = mergeConfig(config, base);
  }

  // Dev override (field-level merge on top of base)
  if (isDev()) {
    const dev = loadToml(join(root, "flmux.dev.toml"));
    if (dev) {
      config = mergeConfig(config, dev);
    }
  }

  return config;
}
