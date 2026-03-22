import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function resolveWorkspaceRoot(startPath = Bun.main): string | null {
  let current = dirname(startPath);

  for (let index = 0; index < 10; index += 1) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "main", "index.ts"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

export function resolveAppWorkingDirectory(): string {
  return process.env.FLMUX_ROOT?.trim() || resolveWorkspaceRoot() || process.cwd();
}

export function resolvePtydLaunchCommand(): LaunchCommand {
  const workspaceRoot = resolveWorkspaceRoot();
  const sourceEntry = workspaceRoot ? join(workspaceRoot, "src", "main", "index.ts") : null;
  const bunPath = Bun.which("bun");

  if (workspaceRoot && sourceEntry && existsSync(sourceEntry) && bunPath) {
    return {
      command: bunPath,
      args: [sourceEntry, "--ptyd"],
      cwd: workspaceRoot
    };
  }

  return {
    command: process.execPath,
    args: [Bun.main, "--ptyd"],
    cwd: process.cwd()
  };
}
