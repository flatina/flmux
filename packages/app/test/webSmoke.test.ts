import { afterEach, describe, it } from "bun:test";
import { runTokensCli } from "../src/cliTokens";
import { runWebModeBootSmokeScenario } from "./scenarios/webModeBootSmokeScenario";
import {
  allocateFlmuxRootDir,
  cleanupAppHandles,
  launchFlmuxWebApp,
  resolveLaunchAuthDir,
  type AppProcessHandle
} from "./support/realAppSmokeSupport";

const appHandles: AppProcessHandle[] = [];

afterEach(async () => {
  await cleanupAppHandles(appHandles);
});

describe("flmux web smoke", () => {
  it(
    "boots web mode and keeps browser attach, HTTP model calls, and CLI token calls on the same server authority",
    async () => {
      const rootDir = allocateFlmuxRootDir("web-smoke");
      const authDir = resolveLaunchAuthDir(rootDir);

      const bootstrap = await runTokensCli(["bootstrap", "--auth-dir", authDir]) as {
        token: string;
      };

      const app = launchFlmuxWebApp({ rootDir });
      appHandles.push(app);

      try {
        await runWebModeBootSmokeScenario(appHandles, {
          token: bootstrap.token,
          authDir
        });
      } finally {
        // rootDir is removed by cleanupAppHandles via the AppProcessHandle.
      }
    },
    90_000
  );
});
