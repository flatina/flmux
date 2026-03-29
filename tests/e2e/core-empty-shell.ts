#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { cleanupStaleSessions, listRecoverablePtydSessions, listSessions } from "../../src/flmux/client/session-discovery";
import { callJsonRpcIpc } from "../../src/lib/ipc/json-rpc-ipc";
import { waitForApp } from "../smoke/helpers";

const projectRoot = resolve(import.meta.dir, "../..");

async function main() {
  await cleanupStaleSessions();
  const liveSessions = await listSessions();
  for (const session of liveSessions) {
    try {
      const client = createAppRpcClient({ ipcPath: session.ipcPath });
      await client.call("app.quit", undefined);
    } catch {
      // best effort
    }
  }
  const recoverable = await listRecoverablePtydSessions();
  for (const session of recoverable) {
    try {
      await callJsonRpcIpc({ ipcPath: session.controlIpcPath }, "daemon.stop", undefined, 1000);
    } catch {
      // best effort
    }
  }

  const xdgRoot = resolve(tmpdir(), `flmux-core-empty-${Date.now()}`);
  const xdgEnv = {
    XDG_CONFIG_HOME: resolve(xdgRoot, ".config"),
    XDG_DATA_HOME: resolve(xdgRoot, ".local", "share"),
    XDG_STATE_HOME: resolve(xdgRoot, ".local", "state")
  };
  for (const dir of Object.values(xdgEnv)) mkdirSync(dir, { recursive: true });

  const flmuxConfigDir = resolve(xdgEnv.XDG_CONFIG_HOME, "flmux");
  mkdirSync(flmuxConfigDir, { recursive: true });
  writeFileSync(
    resolve(flmuxConfigDir, "extensions.json"),
    `${JSON.stringify({ disabled: ["browser", "code-editor", "dir-tree"] }, null, 2)}\n`,
    "utf-8"
  );
  process.env.XDG_CONFIG_HOME = xdgEnv.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = xdgEnv.XDG_DATA_HOME;
  process.env.XDG_STATE_HOME = xdgEnv.XDG_STATE_HOME;

  console.log("Building...");
  const electrobunBin = resolve(projectRoot, "node_modules/.bin/electrobun");
  const cleanResult = Bun.spawnSync(["bun", "scripts/clean-build.ts"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (cleanResult.exitCode !== 0) {
    throw new Error(`build cleanup failed with exit code ${cleanResult.exitCode}`);
  }
  const buildResult = Bun.spawnSync([electrobunBin, "build"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed with exit code ${buildResult.exitCode}`);
  }

  console.log("Starting app with browser/code-editor/dir-tree extensions disabled...");
  const testEnv = { ...process.env, ...xdgEnv, FLMUX_FRESH: "1", FLMUX_ORPHAN_PTYD: "exit" };
  const app = Bun.spawn([electrobunBin, "dev"], {
    cwd: projectRoot,
    env: testEnv,
    stdout: "ignore",
    stderr: "ignore"
  });

  try {
    const client = await waitForApp(15000, 500);
    const tabs = await client.call("tab.list", undefined);
    const summary = await client.call("app.summary", undefined);

    console.log(`Tabs: ${tabs.workspaces.length}`);
    console.log(`Panes: ${summary.panes.length}`);
    if (tabs.workspaces.length < 1) {
      throw new Error(`Expected at least one workspace tab, got ${tabs.workspaces.length}`);
    }
    if (summary.panes.length < 1) {
      throw new Error(`Expected built-in shell with at least one pane, got ${summary.panes.length}`);
    }
    if (!summary.panes.some((pane) => pane.kind === "terminal")) {
      throw new Error("Expected built-in terminal pane even when core extension is disabled");
    }
  } finally {
    console.log("Stopping app...");
    app.kill();
    await app.exited;
    await new Promise((resolveDone) => setTimeout(resolveDone, 1000));
    rmSync(xdgRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
