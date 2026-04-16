import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PtydLaunchPlan } from "@flmux/core/terminal/ptyd/client";

export function createAppPtydLaunchPlan(): PtydLaunchPlan {
  const launch = resolveAppPtydEntry();
  return {
    ...launch,
    launch(env) {
      launchDetachedProcess(launch, env);
    }
  };
}

export function resolveAppPtydEntry(
  baseDir = import.meta.dir,
  fileExists: (path: string) => boolean = existsSync,
  bunCommand = resolveBunCommand()
) {
  const sourceEntrypoint = resolve(baseDir, "daemonMain.ts");
  if (fileExists(sourceEntrypoint)) {
    return {
      command: bunCommand,
      args: [sourceEntrypoint],
      cwd: dirname(sourceEntrypoint)
    };
  }

  const siblingBundledEntrypoint = resolve(baseDir, "ptyd.js");
  if (fileExists(siblingBundledEntrypoint)) {
    return {
      command: bunCommand,
      args: [siblingBundledEntrypoint],
      cwd: dirname(siblingBundledEntrypoint)
    };
  }

  const appDistEntrypoint = resolve(baseDir, "../../../dist/ptyd.js");
  if (fileExists(appDistEntrypoint)) {
    return {
      command: bunCommand,
      args: [appDistEntrypoint],
      cwd: dirname(appDistEntrypoint)
    };
  }

  const repoDistEntrypoint = resolve(baseDir, "../../../../../dist/ptyd.js");
  return {
    command: bunCommand,
    args: [repoDistEntrypoint],
    cwd: dirname(repoDistEntrypoint)
  };
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}

function launchDetachedProcess(
  launch: { command: string; args: string[]; cwd: string },
  env: Record<string, string | undefined>
) {
  const shouldHideViaPowerShell = process.platform === "win32" && !isDevLikeProcess();
  if (shouldHideViaPowerShell) {
    const powerShell = Bun.which("pwsh.exe") ?? Bun.which("pwsh") ?? Bun.which("powershell.exe") ?? Bun.which("powershell");
    if (powerShell) {
      const command = [
        "Start-Process",
        "-WindowStyle Hidden",
        `-FilePath ${quotePowerShell(launch.command)}`,
        `-ArgumentList @(${launch.args.map((arg) => quotePowerShell(arg)).join(", ")})`
      ].join(" ");

      spawn(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: launch.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env
      }).unref();
      return;
    }
  }

  spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  }).unref();
}

function isDevLikeProcess() {
  return process.env.FLMUX_DEV_MODE === "1" || [...process.argv, ...Bun.argv].some((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.js"));
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
