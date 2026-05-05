import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

// Kill any flmux listening on the configured port, then hand off to `bun run dev`.
// `bun run dev` already chains `build:extensions`, so this collapses kill+build+restart
// into a single tool invocation. Port resolution mirrors `auth/serverConfig.ts`:
// FLMUX_PORT env > <rootDir>/.flmux/app.toml. No port pinned → skip kill (assume nothing running).
const rootDir = process.env.FLMUX_ROOT_DIR ?? resolve(import.meta.dir, "..");
const forwarded = process.argv.slice(2);
const port = resolvePort(rootDir, forwarded);

if (port !== undefined) await killListenersOnPort(port);

spawn("bun", ["run", "dev", ...forwarded], { stdio: "inherit", shell: true }).on("exit", (code) =>
  process.exit(code ?? 0)
);

function resolvePort(root: string, argv: readonly string[]): number | undefined {
  const fromArg = parsePort(argv[argv.indexOf("--port") + 1]);
  if (fromArg !== undefined) return fromArg;
  const fromEnv = parsePort(process.env.FLMUX_PORT);
  if (fromEnv !== undefined) return fromEnv;
  const tomlPath = resolve(root, ".flmux", "app.toml");
  if (!existsSync(tomlPath)) return undefined;
  const m = /^\s*port\s*=\s*(\d+)/m.exec(readFileSync(tomlPath, "utf8"));
  return m ? parsePort(m[1]) : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

async function killListenersOnPort(p: number) {
  const pids =
    process.platform === "win32"
      ? findWindowsPids(p)
      : findUnixPids(p);
  if (pids.length === 0) return;
  for (const pid of pids) {
    Bun.spawnSync(process.platform === "win32" ? ["taskkill", "/F", "/PID", pid] : ["kill", "-9", pid]);
  }
  await new Promise((r) => setTimeout(r, 300));
}

function findWindowsPids(p: number): string[] {
  const r = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue).OwningProcess`
  ]);
  return new TextDecoder().decode(r.stdout).trim().split(/\s+/).filter(Boolean);
}

function findUnixPids(p: number): string[] {
  const r = Bun.spawnSync(["lsof", "-ti", `:${p}`]);
  return new TextDecoder().decode(r.stdout).trim().split(/\s+/).filter(Boolean);
}
