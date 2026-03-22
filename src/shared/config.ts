export type LogLevel = "error" | "warn" | "info" | "debug";

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
  ptyd: {
    stopOnExit: boolean;
  };
}

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.includes(value as LogLevel);
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
    },
    ptyd: {
      stopOnExit: isDev
    }
  };
}

export function mergeConfig(defaults: FlmuxConfig, parsed: Record<string, unknown>): FlmuxConfig {
  const app = typeof parsed.app === "object" && parsed.app ? (parsed.app as Record<string, unknown>) : {};
  const log = typeof parsed.log === "object" && parsed.log ? (parsed.log as Record<string, unknown>) : {};
  const web = typeof parsed.web === "object" && parsed.web ? (parsed.web as Record<string, unknown>) : {};
  const ptyd = typeof parsed.ptyd === "object" && parsed.ptyd ? (parsed.ptyd as Record<string, unknown>) : {};

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
    },
    ptyd: {
      stopOnExit: typeof ptyd.stopOnExit === "boolean" ? ptyd.stopOnExit : defaults.ptyd.stopOnExit
    }
  };
}
