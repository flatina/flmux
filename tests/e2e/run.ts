#!/usr/bin/env bun
/**
 * E2E test runner — starts the app, runs tests, stops the app.
 *
 * Usage:
 *   bun tests/e2e/run.ts                          → run all e2e tests
 *   bun tests/e2e/run.ts terminal-flmux-cli       → run specific test
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { cleanupStaleSessions, listRecoverablePtydSessions, listSessions } from "../../src/flmux/client/session-discovery";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { callJsonRpcIpc } from "../../src/lib/ipc/json-rpc-ipc";
import { waitForApp } from "../smoke/helpers";

const projectRoot = resolve(import.meta.dir, "../..");
const testNames = process.argv.slice(2);
const testWebRoot = resolve(projectRoot, "tests", "web");

type TestExecutionMode = "shared-app" | "isolated-app";

const TEST_EXECUTION_MODES: Record<string, TestExecutionMode> = {
  "browser-early-close": "isolated-app",
  "browser-cdp-readiness": "isolated-app",
  "browser-reopen-after-all-close": "isolated-app",
  "web-property-system": "isolated-app"
};

type StartedTestApp = {
  app: ReturnType<typeof Bun.spawn>;
  env: Record<string, string | undefined>;
  xdgRoot: string;
};

async function main() {
  await cleanupStaleSessions();
  await stopRunningApps();
  await stopRecoverablePtyds();

  let activeMode: TestExecutionMode | null = null;
  let currentApp: StartedTestApp | null = null;

  // Build first to ensure latest source is compiled
  console.log("Building...");
  const cleanResult = Bun.spawnSync(["bun", "scripts/clean-build.ts"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (cleanResult.exitCode !== 0) {
    throw new Error(`build cleanup failed with exit code ${cleanResult.exitCode}`);
  }
  const electrobunBin = resolve(projectRoot, "node_modules/.bin/electrobun");
  const buildResult = Bun.spawnSync([electrobunBin, "build"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed with exit code ${buildResult.exitCode}`);
  }

  try {
    const tests = testNames.length > 0
      ? testNames
      : ["terminal-flmux-cli"];

    let failed = 0;

    for (const name of tests) {
      const mode = getTestExecutionMode(name);
      if (mode !== activeMode) {
        if (currentApp) {
          await stopTestApp(currentApp);
          currentApp = null;
        }

        if (mode === "shared-app") {
          currentApp = await startTestApp(projectRoot, testWebRoot);
        }

        activeMode = mode;
      }

      const appForTest =
        mode === "isolated-app" ? await startTestApp(projectRoot, testWebRoot) : currentApp;

      if (!appForTest) {
        throw new Error(`Failed to start app for test ${name}`);
      }

      try {
        console.log(`── ${name} ──`);
        const testPath = resolve(import.meta.dir, `../smoke/${name}.ts`);
        const result = Bun.spawnSync(["bun", testPath], {
          cwd: projectRoot,
          env: appForTest.env,
          stdout: "inherit",
          stderr: "inherit"
        });
        if (result.exitCode !== 0) {
          failed++;
          console.log(`── ${name}: FAILED ──\n`);
        } else {
          console.log(`── ${name}: OK ──\n`);
        }
      } finally {
        if (mode === "isolated-app") {
          await stopTestApp(appForTest);
        }
      }
    }

    if (failed > 0) {
      console.log(`\n${failed} test(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll tests passed.");
    }
  } finally {
    if (currentApp) {
      await stopTestApp(currentApp);
    }
    console.log("Done.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

function resolveBuiltAppDir(root: string): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return resolve(root, `build/dev-${platform}-${arch}/flmux-dev`);
}

async function waitForAppOrExit(
  app: ReturnType<typeof Bun.spawn>,
  waitMs: number,
  intervalMs: number
) {
  return Promise.race([
    waitForApp(waitMs, intervalMs),
    app.exited.then((code) => {
      throw new Error(`App exited before ready (exit code ${code})`);
    })
  ]);
}

async function startTestApp(projectRoot: string, testWebRoot: string): Promise<StartedTestApp> {
  console.log("Starting app...");
  const xdgRoot = resolve(tmpdir(), `flmux-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const xdgEnv = {
    XDG_CONFIG_HOME: resolve(xdgRoot, ".config"),
    XDG_DATA_HOME: resolve(xdgRoot, ".local", "share"),
    XDG_STATE_HOME: resolve(xdgRoot, ".local", "state")
  };
  for (const dir of Object.values(xdgEnv)) mkdirSync(dir, { recursive: true });

  const appDir = resolveBuiltAppDir(projectRoot);
  const launch = resolveBuiltLaunch(appDir);
  const testEnv: Record<string, string | undefined> = {
    ...process.env,
    ...xdgEnv,
    FLMUX_FRESH: "1",
    FLMUX_ORPHAN_PTYD: "exit",
    FLMUX_WEB_ROOT: testWebRoot,
    FLMUX_ROOT: projectRoot
  };
  if (process.platform === "win32" && !testEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
    testEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";
  }

  const app = Bun.spawn([launch.command, ...launch.args, "--orphan-ptyd=exit"], {
    cwd: launch.cwd,
    env: testEnv,
    stdout: "ignore",
    stderr: "ignore"
  });

  console.log(`App PID: ${app.pid}`);
  await waitForAppOrExit(app, 15000, 500);
  console.log("App is ready.\n");

  return {
    app,
    env: testEnv,
    xdgRoot
  };
}

async function stopTestApp(started: StartedTestApp): Promise<void> {
  console.log("Stopping app...");
  let sessionId: string | null = null;
  try {
    const client = await waitForApp(3000, 500);
    const identify = await client.call("system.identify", undefined);
    sessionId = identify.sessionId;
    await client.call("app.quit", undefined);
  } catch {
    // fallback to kill
  }
  started.app.kill();
  await started.app.exited;
  if (sessionId) {
    try {
      await callJsonRpcIpc(
        {
          ipcPath: getPtydControlIpcPath(sessionId)
        },
        "daemon.stop",
        undefined,
        1000
      );
    } catch {
      // best effort cleanup
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(started.xdgRoot, { recursive: true, force: true });
}

function getTestExecutionMode(name: string): TestExecutionMode {
  return TEST_EXECUTION_MODES[name] ?? "shared-app";
}

function resolveBuiltLaunch(appDir: string): { command: string; args: string[]; cwd: string } {
  const launcherCandidates = process.platform === "win32"
    ? [join(appDir, "bin", "launcher.exe")]
    : [join(appDir, "bin", "launcher"), join(appDir, "MacOS", "launcher")];

  const launcher = launcherCandidates.find((candidate) => existsSync(candidate));
  if (launcher) {
    return {
      command: launcher,
      args: [],
      cwd: appDir
    };
  }

  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const bundledBun = join(appDir, "bin", bunName);
  const bundledMain = join(appDir, "Resources", "main.js");
  if (existsSync(bundledBun) && existsSync(bundledMain)) {
    return {
      command: bundledBun,
      args: [bundledMain],
      cwd: appDir
    };
  }

  throw new Error(`Built launcher not found under ${appDir}`);
}

async function stopRecoverablePtyds(): Promise<void> {
  const recoverable = await listRecoverablePtydSessions();
  for (const session of recoverable) {
    try {
      await callJsonRpcIpc({ ipcPath: session.controlIpcPath }, "daemon.stop", undefined, 1000);
    } catch {
      // best effort
    }
  }
}

async function stopRunningApps(): Promise<void> {
  const sessions = await listSessions();
  for (const session of sessions) {
    try {
      const client = createAppRpcClient({ ipcPath: session.ipcPath });
      await client.call("app.quit", undefined);
    } catch {
      // best effort
    }
  }
}
