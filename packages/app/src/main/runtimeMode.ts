import type { FlmuxRuntimeMode } from "../shared/runtimeMode";

export function resolveFlmuxRuntimeMode(argv: readonly string[] = Bun.argv): FlmuxRuntimeMode {
  return argv.includes("--web") ? "web" : "desktop";
}
