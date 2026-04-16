import { afterEach, describe, it } from "bun:test";
import { runWebModeBootSmokeScenario } from "./scenarios/webModeBootSmokeScenario";
import {
  cleanupAppHandles,
  type AppProcessHandle,
  launchFlmuxWebApp
} from "./support/realAppSmokeSupport";

const appHandles: AppProcessHandle[] = [];

afterEach(async () => {
  await cleanupAppHandles(appHandles);
});

describe("flmux web smoke", () => {
  it(
    "boots web mode and keeps browser attach, HTTP model calls, and CLI token calls on the same server authority",
    async () => {
      const token = `flmux-web-smoke-${crypto.randomUUID()}`;
      const app = launchFlmuxWebApp(token);
      appHandles.push(app);
      await runWebModeBootSmokeScenario(appHandles);
    },
    90_000
  );
});
