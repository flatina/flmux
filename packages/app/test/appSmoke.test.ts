import { afterAll, afterEach, describe, it } from "bun:test";
import { runAppBootSmokeScenario } from "./scenarios/appBootSmokeScenario";
import { runTerminalRestartAdoptSmokeScenario } from "./scenarios/terminalRestartAdoptSmokeScenario";
import { runTerminalRestartRecreateSmokeScenario } from "./scenarios/terminalRestartRecreateSmokeScenario";
import { runWorkspaceResetSmokeScenario } from "./scenarios/workspaceResetSmokeScenario";
import {
  cleanupAppHandles,
  stopAppWorkspaceDaemons,
  type AppProcessHandle
} from "./support/realAppSmokeSupport";

const appHandles: AppProcessHandle[] = [];

afterEach(async () => {
  await cleanupAppHandles(appHandles);
});

afterAll(() => {
  void stopAppWorkspaceDaemons();
});

describe("flmux app smoke", () => {
  it(
    "boots the real app, switches workspace, and opens a browser pane",
    async () => {
      await runAppBootSmokeScenario(appHandles);
    },
    60_000
  );

  it(
    "reattaches surviving terminal runtimes after flmux restart",
    async () => {
      await runTerminalRestartAdoptSmokeScenario(appHandles);
    },
    90_000
  );

  it(
    "recreates restored terminal runtimes when no surviving daemon can be adopted",
    async () => {
      await runTerminalRestartRecreateSmokeScenario(appHandles);
    },
    90_000
  );

  it(
    "resets a workspace through the same cleanup path and kills attached runtimes",
    async () => {
      await runWorkspaceResetSmokeScenario(appHandles);
    },
    60_000
  );
});
