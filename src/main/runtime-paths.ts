import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export function resolveWebRoot(argv = process.argv): string | null {
  const index = argv.findIndex((value) => value === "--web-root");
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  if (value) {
    return resolve(value);
  }

  const envValue = process.env.FLMUX_WEB_ROOT?.trim();
  return envValue ? resolve(envValue) : null;
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
