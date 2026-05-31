import { afterAll, afterEach, describe, it } from "bun:test";
import { runTerminalRestartAdoptSmokeScenario } from "./scenarios/terminalRestartAdoptSmokeScenario";
import { runTerminalRestartRecreateSmokeScenario } from "./scenarios/terminalRestartRecreateSmokeScenario";
import { cleanupAppHandles, stopAppWorkspaceDaemons, type AppProcessHandle } from "./support/realAppSmokeSupport";

const appHandles: AppProcessHandle[] = [];

// 30s cap covers CEF cache-lock release (a few hundred ms × retries)
// + daemon.stop IPC + rm-rf of the per-test rootDir.
afterEach(async () => {
  await cleanupAppHandles(appHandles);
}, 30_000);

afterAll(() => {
  void stopAppWorkspaceDaemons();
});

describe("flmux app smoke", () => {
  // Skipped on Windows: adoption needs the detached ptyd daemon to outlive the
  // killed app, but `bun test`'s Job Object tears it down — a topology absent in
  // the compiled exe (verified to adopt) and on POSIX (setsid survives). Backend
  // adoption is unit-covered in ptydBackend.test.ts; this canary runs on POSIX.
  it.skipIf(process.platform === "win32")("reattaches surviving terminal runtimes after flmux restart", async () => {
    await runTerminalRestartAdoptSmokeScenario(appHandles);
  }, 90_000);

  it("recreates restored terminal runtimes when no surviving daemon can be adopted", async () => {
    await runTerminalRestartRecreateSmokeScenario(appHandles);
  }, 90_000);
});
