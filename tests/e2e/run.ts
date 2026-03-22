#!/usr/bin/env bun
/**
 * E2E test runner — starts the app, runs tests, stops the app.
 *
 * Usage:
 *   bun tests/e2e/run.ts                          → run all e2e tests
 *   bun tests/e2e/run.ts terminal-flmux-cli       → run specific test
 */
import { resolve } from "node:path";
import { waitForApp } from "../smoke/helpers";

const projectRoot = resolve(import.meta.dir, "../..");
const testNames = process.argv.slice(2);

async function main() {
  // Build first to ensure latest source is compiled
  console.log("Building...");
  const electrobunBin = resolve(projectRoot, "node_modules/.bin/electrobun");
  const buildResult = Bun.spawnSync([electrobunBin, "build"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed with exit code ${buildResult.exitCode}`);
  }

  console.log("Starting app...");
  const app = Bun.spawn([electrobunBin, "dev"], {
    cwd: projectRoot,
    env: { ...process.env, FLMUX_FRESH: "1" },
    stdout: "ignore",
    stderr: "ignore"
  });

  try {
    console.log(`App PID: ${app.pid}`);
    const client = await waitForApp(15000, 500);
    console.log("App is ready.\n");

    const tests = testNames.length > 0
      ? testNames
      : ["terminal-flmux-cli"];

    let failed = 0;
    for (const name of tests) {
      console.log(`── ${name} ──`);
      const testPath = resolve(import.meta.dir, `../smoke/${name}.ts`);
      const result = Bun.spawnSync(["bun", testPath], {
        cwd: projectRoot,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit"
      });
      if (result.exitCode !== 0) {
        failed++;
        console.log(`── ${name}: FAILED ──\n`);
      } else {
        console.log(`── ${name}: OK ──\n`);
      }
    }

    if (failed > 0) {
      console.log(`\n${failed} test(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll tests passed.");
    }
  } finally {
    console.log("Stopping app...");
    try {
      const client = await waitForApp(3000, 500);
      await client.call("app.quit", undefined);
    } catch {
      // fallback to kill
    }
    app.kill();
    await app.exited;
    // Wait for ptyd to shut down
    await new Promise((r) => setTimeout(r, 2000));
    console.log("Done.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
