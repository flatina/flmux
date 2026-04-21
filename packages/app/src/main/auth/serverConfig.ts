import { existsSync, readFileSync } from "node:fs";

export interface FlmuxServerPortResolution {
  port: number | undefined;
  source: "cli" | "env" | "config" | "default";
}

/**
 * Resolve the server port with a 3-tier priority:
 *   1. `--port <n>` CLI flag
 *   2. `FLMUX_PORT` env var
 *   3. `configFile` — `[server] port` (typically `<flmuxDir>/server.toml`)
 * Returns `{ port: undefined, source: "default" }` when nothing is set —
 * the caller should treat that as "let the OS pick" (Bun listens on 0).
 */
export function resolveFlmuxServerPort(options: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  configFile?: string | null;
}): FlmuxServerPortResolution {
  const argv = options.argv ?? Bun.argv;
  const env = options.env ?? process.env;

  const fromArg = readPortFlag(argv);
  if (fromArg !== undefined) return { port: fromArg, source: "cli" };

  const fromEnv = normalizePort(env.FLMUX_PORT);
  if (fromEnv !== undefined) return { port: fromEnv, source: "env" };

  if (options.configFile) {
    const fromFile = readServerConfigPort(options.configFile);
    if (fromFile !== undefined) return { port: fromFile, source: "config" };
  }

  return { port: undefined, source: "default" };
}

function readPortFlag(argv: readonly string[]): number | undefined {
  const i = argv.indexOf("--port");
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return normalizePort(argv[i + 1]);
}

function readServerConfigPort(filePath: string): number | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = Bun.TOML.parse(raw) as { server?: { port?: unknown } };
    return normalizePort(parsed.server?.port);
  } catch {
    return undefined;
  }
}

function normalizePort(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value.trim(), 10) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}
