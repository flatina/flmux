import { createConfig } from "@flatina/confkit";

const DEFAULT_DISPLAY_TEMPLATE = "${appName} v${appVersion}";

// confkit layering: defaults < app.toml < FLMUX_* env < CLI; invalid values fail the boot.
export interface FlmuxBootConfig {
  app: {
    name: string | undefined; // also the `${appName}` template var
    appTitle: string;
    watermarkHeader: string | undefined; // unset → hidden
    watermarkFooter: string;
  };
  server: {
    port: number | undefined; // undefined → OS picks
    portSource: "cli" | "env" | "config" | "default";
    publicOrigin: string | undefined;
    rateLimit: { max: number; windowMs: number };
    ws: { pingIntervalMs: number; idleTimeoutSeconds: number };
    trustedProxies: string | undefined; // comma list; undefined → loopback
  };
  limits: {
    maxSessionsPerUser: number;
    maxPanesPerUser: number;
    maxTerminalsPerUser: number;
    maxUploadBytes: number | undefined; // per-file; undefined → 2 GiB default
  };
  grace: { clientMs: number | undefined; authorityEvictionMs: number | undefined };
}

export async function loadFlmuxBootConfig(options: {
  appConfigFile: string | null | undefined;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
}): Promise<FlmuxBootConfig> {
  const builder = createConfig<FlmuxBootConfig>({
    env: options.env ?? process.env,
    argv: normalizeValuedFlags(options.argv ?? Bun.argv, ["--port"])
  }).useDefaults({}, { name: "default" });
  if (options.appConfigFile) {
    builder.useTomlFile(options.appConfigFile, { name: "config", required: false });
  }
  builder
    .useEnv({
      name: "env",
      map: {
        FLMUX_PORT: "server.port",
        FLMUX_PUBLIC_ORIGIN: "server.publicOrigin",
        FLMUX_RATELIMIT_MAX: "server.rateLimit.max",
        FLMUX_RATELIMIT_WINDOW_MS: "server.rateLimit.windowMs",
        FLMUX_WS_PING_INTERVAL_MS: "server.ws.pingIntervalMs",
        FLMUX_WS_IDLE_TIMEOUT_SECONDS: "server.ws.idleTimeoutSeconds",
        FLMUX_TRUSTED_PROXIES: "server.trustedProxies",
        FLMUX_MAX_SESSIONS_PER_USER: "limits.maxSessionsPerUser",
        FLMUX_MAX_PANES_PER_USER: "limits.maxPanesPerUser",
        FLMUX_MAX_TERMINALS_PER_USER: "limits.maxTerminalsPerUser",
        FLMUX_MAX_UPLOAD_BYTES: "limits.maxUploadBytes",
        FLMUX_CLIENT_GRACE_MS: "grace.clientMs",
        FLMUX_AUTHORITY_EVICTION_GRACE_MS: "grace.authorityEvictionMs"
      }
    })
    .useArgv({ name: "cli", map: { port: "server.port" } })
    .validate((value) => normalize(value as unknown as Record<string, unknown>));
  let config: Awaited<ReturnType<(typeof builder)["load"]>>;
  try {
    config = await builder.load();
  } catch (error) {
    // confkit wraps validator throws — surface the actual reason.
    throw (error as { cause?: unknown }).cause ?? error;
  }
  const portTrace = config.getTrace("server.port").find((t) => t.effective);
  const snapshot: FlmuxBootConfig = {
    ...config.value,
    server: { ...config.value.server, portSource: toPortSource(portTrace?.source) }
  };
  config.dispose();
  return snapshot;
}

function toPortSource(source: string | undefined): FlmuxBootConfig["server"]["portSource"] {
  return source === "cli" || source === "env" || source === "config" ? source : "default";
}

function normalize(raw: Record<string, unknown>): FlmuxBootConfig {
  const app = asRecord(raw.app);
  const server = asRecord(raw.server);
  const rateLimit = asRecord(server.rateLimit);
  const ws = asRecord(server.ws);
  const limits = asRecord(raw.limits);
  const grace = asRecord(raw.grace);
  return {
    app: {
      name: nonEmpty(app.name),
      appTitle: nonEmpty(app.appTitle) ?? DEFAULT_DISPLAY_TEMPLATE,
      watermarkHeader: nonEmpty(app.watermarkHeader),
      watermarkFooter: nonEmpty(app.watermarkFooter) ?? DEFAULT_DISPLAY_TEMPLATE
    },
    server: {
      port: port(server.port),
      portSource: "default", // overwritten from trace after load
      publicOrigin: nonEmpty(server.publicOrigin),
      rateLimit: {
        max: positive(rateLimit.max, "FLMUX_RATELIMIT_MAX") ?? 600,
        windowMs: positive(rateLimit.windowMs, "FLMUX_RATELIMIT_WINDOW_MS") ?? 60_000
      },
      ws: {
        pingIntervalMs: positive(ws.pingIntervalMs, "FLMUX_WS_PING_INTERVAL_MS") ?? 25_000,
        idleTimeoutSeconds: positive(ws.idleTimeoutSeconds, "FLMUX_WS_IDLE_TIMEOUT_SECONDS") ?? 120
      },
      trustedProxies: nonEmpty(server.trustedProxies)
    },
    limits: {
      maxSessionsPerUser: positive(limits.maxSessionsPerUser, "FLMUX_MAX_SESSIONS_PER_USER") ?? 25,
      maxPanesPerUser: positive(limits.maxPanesPerUser, "FLMUX_MAX_PANES_PER_USER") ?? 200,
      maxTerminalsPerUser: positive(limits.maxTerminalsPerUser, "FLMUX_MAX_TERMINALS_PER_USER") ?? 50,
      maxUploadBytes: positive(limits.maxUploadBytes, "FLMUX_MAX_UPLOAD_BYTES")
    },
    grace: {
      clientMs: positive(grace.clientMs, "FLMUX_CLIENT_GRACE_MS"),
      authorityEvictionMs: positive(grace.authorityEvictionMs, "FLMUX_AUTHORITY_EVICTION_GRACE_MS")
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Tolerates whitespace padding (.env/systemd); trailing junk stays invalid.
function toInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isInteger(n) ? n : undefined;
  }
  return undefined;
}

function port(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = toInt(value);
  if (n !== undefined && n >= 0 && n <= 65535) return n;
  throw new Error(`invalid port: ${String(value)}`);
}

/** Positive integer; empty/absent → undefined (default applies), else error. */
function positive(value: unknown, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = toInt(value);
  if (n === undefined || n <= 0) throw new Error(`invalid ${label}: ${String(value)}`);
  return n;
}

/** confkit argv parses `--key=value` only; rewrite known `--flag value` pairs. */
function normalizeValuedFlags(argv: readonly string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (flags.includes(arg) && next !== undefined && !next.startsWith("--")) {
      out.push(`${arg}=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}
