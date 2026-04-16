import { afterEach, describe, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTokensCli } from "../src/cliTokens";
import { runWebModeBootSmokeScenario } from "./scenarios/webModeBootSmokeScenario";
import {
  cleanupAppHandles,
  type AppProcessHandle,
  launchFlmuxWebApp
} from "./support/realAppSmokeSupport";

const appHandles: AppProcessHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupAppHandles(appHandles);
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("flmux web smoke", () => {
  it(
    "boots web mode and keeps browser attach, HTTP model calls, and CLI token calls on the same server authority",
    async () => {
      const authDir = await mkdtemp(join(tmpdir(), "flmux-web-smoke-auth-"));
      tempDirs.push(authDir);

      const bootstrap = await runTokensCli(["bootstrap", "--auth-dir", authDir]) as {
        token: string;
      };

      const app = launchFlmuxWebApp({ authDir });
      appHandles.push(app);

      await runWebModeBootSmokeScenario(appHandles, {
        token: bootstrap.token,
        authDir
      });
    },
    90_000
  );
});
