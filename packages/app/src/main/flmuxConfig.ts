import { createConfig } from "@flatina/confkit";

const DEFAULT_DISPLAY_TEMPLATE = "${appName} v${appVersion}";

// confkit layering: defaults < app.toml < FLMUX_* env < CLI; invalid values fail the boot.
export interface FlmuxBootConfig {
  app: {
    name: string | undefined; // also the `${appName}` template var
    appTitle: string;
    watermarkHeader: string | undefined; // unset → hidden
    watermarkFooter: string;
    aboutMessage: string | undefined; // free-form About blurb (copyright/notice); unset → hidden
  };
  server: {
    host: string; // bind address; default 127.0.0.1 (loopback). FLMUX_HOST; 0.0.0.0 = all NICs
    port: number | undefined; // undefined → OS picks
    portSource: "cli" | "env" | "config" | "default";
    publicOrigin: string | undefined;
    rateLimit: { max: number; windowMs: number; userMax: number };
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
  auth: {
    /** Enabled human login methods. `passkey` (internet/stable-domain) and/or
     * `totp` (closed-network passwordless). OSS default: passkey only. */
    methods: string[];
    /** Minted session lifetime (ms). Shorter for cleartext deployments — the
     * session cookie is a bearer that transits every request. Default 30d. */
    sessionTtlMs: number;
    totp: {
      /** ± steps tolerated around the current period (clock-drift slack on
       * air-gapped hosts). 1 ⇒ ±30s. Wider = larger brute-force surface. */
      windowSteps: number;
      /** Consecutive failed codes before a username is locked. */
      maxFailures: number;
      /** Lock duration (ms) once maxFailures is hit. */
      lockMs: number;
    };
  };
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
        FLMUX_HOST: "server.host",
        FLMUX_PORT: "server.port",
        FLMUX_PUBLIC_ORIGIN: "server.publicOrigin",
        FLMUX_RATELIMIT_MAX: "server.rateLimit.max",
        FLMUX_RATELIMIT_USER_MAX: "server.rateLimit.userMax",
        FLMUX_RATELIMIT_WINDOW_MS: "server.rateLimit.windowMs",
        FLMUX_WS_PING_INTERVAL_MS: "server.ws.pingIntervalMs",
        FLMUX_WS_IDLE_TIMEOUT_SECONDS: "server.ws.idleTimeoutSeconds",
        FLMUX_TRUSTED_PROXIES: "server.trustedProxies",
        FLMUX_MAX_SESSIONS_PER_USER: "limits.maxSessionsPerUser",
        FLMUX_MAX_PANES_PER_USER: "limits.maxPanesPerUser",
        FLMUX_MAX_TERMINALS_PER_USER: "limits.maxTerminalsPerUser",
        FLMUX_MAX_UPLOAD_BYTES: "limits.maxUploadBytes",
        FLMUX_CLIENT_GRACE_MS: "grace.clientMs",
        FLMUX_AUTHORITY_EVICTION_GRACE_MS: "grace.authorityEvictionMs",
        FLMUX_AUTH_METHODS: "auth.methods",
        FLMUX_SESSION_TTL_MS: "auth.sessionTtlMs",
        FLMUX_TOTP_WINDOW_STEPS: "auth.totp.windowSteps",
        FLMUX_TOTP_MAX_FAILURES: "auth.totp.maxFailures",
        FLMUX_TOTP_LOCK_MS: "auth.totp.lockMs"
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
  const auth = asRecord(raw.auth);
  const totp = asRecord(auth.totp);
  return {
    app: {
      name: nonEmpty(app.name),
      appTitle: nonEmpty(app.appTitle) ?? DEFAULT_DISPLAY_TEMPLATE,
      watermarkHeader: nonEmpty(app.watermarkHeader),
      watermarkFooter: nonEmpty(app.watermarkFooter) ?? DEFAULT_DISPLAY_TEMPLATE,
      aboutMessage: nonEmpty(app.aboutMessage)
    },
    server: {
      host: nonEmpty(server.host) ?? "127.0.0.1",
      port: port(server.port),
      portSource: "default", // overwritten from trace after load
      publicOrigin: nonEmpty(server.publicOrigin),
      rateLimit: {
        max: positive(rateLimit.max, "FLMUX_RATELIMIT_MAX") ?? 600,
        // Large: one agent action fans out to many path RPCs, so a tight cap trips legit use.
        userMax: positive(rateLimit.userMax, "FLMUX_RATELIMIT_USER_MAX") ?? 6000,
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
    },
    auth: {
      methods: methodList(auth.methods),
      sessionTtlMs: positive(auth.sessionTtlMs, "FLMUX_SESSION_TTL_MS") ?? 30 * 24 * 60 * 60 * 1000,
      totp: {
        windowSteps: boundedNonNeg(totp.windowSteps, "FLMUX_TOTP_WINDOW_STEPS", 3) ?? 1,
        maxFailures: positive(totp.maxFailures, "FLMUX_TOTP_MAX_FAILURES") ?? 5,
        lockMs: positive(totp.lockMs, "FLMUX_TOTP_LOCK_MS") ?? 15 * 60 * 1000
      }
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

/** Integer in [0, max]; empty/absent → undefined (default applies). Unlike
 * `positive`, 0 is valid (TOTP windowSteps=0 ⇒ exact-period only). */
function boundedNonNeg(value: unknown, label: string, max: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = toInt(value);
  if (n === undefined || n < 0 || n > max) throw new Error(`invalid ${label}: ${String(value)} (0-${max})`);
  return n;
}

const KNOWN_AUTH_METHODS = ["passkey", "totp"];

/** Enabled auth methods: TOML array or comma string; empty/absent → ["passkey"].
 * Unknown names fail the boot (fail-fast) — a typo would otherwise silently
 * disable all login and lock everyone out. */
function methodList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const methods = raw.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
  for (const m of methods) {
    if (!KNOWN_AUTH_METHODS.includes(m)) {
      throw new Error(`invalid FLMUX_AUTH_METHODS: unknown method '${m}' (allowed: ${KNOWN_AUTH_METHODS.join(", ")})`);
    }
  }
  return methods.length > 0 ? methods : ["passkey"];
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
