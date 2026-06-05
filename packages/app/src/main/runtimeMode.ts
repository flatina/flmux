import type { FlmuxRuntimeMode } from "../shared/runtimeMode";

export function resolveFlmuxRuntimeMode(argv: readonly string[] = Bun.argv): FlmuxRuntimeMode {
  return argv.includes("--web") ? "web" : "desktop";
}

export function resolveFlmuxDevMode(
  argv: readonly string[] = Bun.argv,
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.FLMUX_DEV_MODE === "1" || argv.includes("--dev");
}

export function resolveFlmuxHiddenWindow(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLMUX_HIDDEN_WINDOW === "1";
}
