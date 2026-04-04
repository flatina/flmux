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
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "flmux", "main", "index.ts"))) {
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

export function resolveEmbeddedExtensionRoot(startPath = Bun.main): string | null {
  let current = dirname(startPath);

  for (let index = 0; index < 10; index += 1) {
    for (const candidate of [current, join(current, "app"), join(current, "Resources", "app")]) {
      if (existsSync(join(candidate, "ext"))) {
        return candidate;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return resolveWorkspaceRoot(startPath);
}

export function resolveAppWorkingDirectory(): string {
  return process.env.FLMUX_ROOT?.trim() || resolveWorkspaceRoot() || process.cwd();
}

export function resolveWebRoot(baseDir?: string, argv = process.argv): string | null {
  const index = argv.findIndex((value) => value === "--web-root");
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  if (value) {
    return baseDir ? resolve(baseDir, value) : resolve(value);
  }

  const envValue = process.env.FLMUX_WEB_ROOT?.trim();
  if (!envValue) return null;
  return baseDir ? resolve(baseDir, envValue) : resolve(envValue);
}

export function resolvePtydLaunchCommand(): LaunchCommand {
  const workspaceRoot = resolveWorkspaceRoot();
  const sourceEntry = workspaceRoot ? join(workspaceRoot, "src", "ptyd", "index.ts") : null;
  const bunPath = Bun.which("bun");
  const bundledBun = resolveBundledBunBinary();
  const sourceBun = bunPath || bundledBun;

  if (workspaceRoot && sourceEntry && existsSync(sourceEntry) && sourceBun) {
    return {
      command: sourceBun,
      args: [sourceEntry],
      cwd: workspaceRoot
    };
  }

  if (bundledBun) {
    return {
      command: bundledBun,
      args: [Bun.main, "--ptyd"],
      cwd: process.cwd()
    };
  }

  return {
    command: process.execPath,
    args: [Bun.main, "--ptyd"],
    cwd: process.cwd()
  };
}

function resolveBundledBunBinary(): string | null {
  const execDir = dirname(process.execPath);
  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const candidate = join(execDir, bunName);
  return existsSync(candidate) ? candidate : null;
}
