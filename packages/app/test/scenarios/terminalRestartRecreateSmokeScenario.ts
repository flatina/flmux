import { expect } from "bun:test";
import { stopOwnedPtydDaemonsForRootDir } from "../support/ptydCleanup";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import {
  allocateFlmuxRootDir,
  fetchTargets,
  killMainProcessOnly,
  launchFlmuxApp,
  postJson,
  resolveLaunchSessionFile,
  stopAppWorkspaceDaemons,
  waitFor,
  waitForMainTarget,
  waitForSingleClientId
} from "../support/realAppSmokeSupport";

export async function runTerminalRestartRecreateSmokeScenario(appHandles: AppProcessHandle[]) {
  await stopAppWorkspaceDaemons();
  const port = 10100 + Math.floor(Math.random() * 100);
  const secondPort = port + 300;
  const rootDir = allocateFlmuxRootDir("session");
  const sessionFile = resolveLaunchSessionFile(rootDir);
  const firstApp = launchFlmuxApp(port, rootDir);
  appHandles.push(firstApp);

  try {
    const firstMainTarget = await waitForMainTarget(port, "recreate first main flmux target");
    const firstOrigin = new URL(firstMainTarget.url).origin;
    const firstClientId = await waitForSingleClientId(firstOrigin, "recreate first client id");

    const newPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: {
          paneId: string;
        };
      };
    }>(`${firstOrigin}/api/model/path/call`, {
      clientId: firstClientId,
      path: "/panes/new",
      args: {
        kind: "terminal",
        cwd: ".",
        place: "right"
      }
    });
    const paneId = newPane.result.value.paneId;

    const attached = await waitFor(
      async () => {
        const status = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: {
              attached: boolean;
              rootKey: string | null;
              runtimeId: string | null;
            };
          };
        }>(`${firstOrigin}/api/model/path/get`, {
          clientId: firstClientId,
          path: `/status/panes/${paneId}/terminal`
        });
        return status.result.value.attached && status.result.value.rootKey && status.result.value.runtimeId
          ? { rootKey: status.result.value.rootKey, runtimeId: status.result.value.runtimeId }
          : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "recreate initial terminal auto-attach" }
    );
    const rootKey = attached.rootKey;
    const firstRuntimeId = attached.runtimeId;

    await waitFor(
      async () => {
        try {
          const saved = await Bun.file(sessionFile).text();
          return saved.includes(paneId) ? true : null;
        } catch {
          return null;
        }
      },
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        label: "recreate persisted session file"
      }
    );

    await killMainProcessOnly(firstApp.process);
    await waitFor(
      async () => {
        try {
          await fetchTargets(port);
          return null;
        } catch {
          return true;
        }
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "recreate first app shutdown" }
    );

    // This scenario's "no surviving daemon" premise: stop the daemon
    // that served firstApp so secondApp re-launches a fresh runtime
    // (different runtimeId) instead of adopting. Targets rootDir, not
    // the install root — daemon is scoped to the test's FLMUX_ROOT_DIR.
    await stopOwnedPtydDaemonsForRootDir(rootDir);

    const secondApp = launchFlmuxApp(secondPort, rootDir);
    appHandles.push(secondApp);

    const secondMainTarget = await waitForMainTarget(secondPort, "recreate second main flmux target");
    const secondOrigin = new URL(secondMainTarget.url).origin;
    const secondClientId = await waitForSingleClientId(secondOrigin, "recreate second client id");

    const paneStatus = await waitFor(
      async () => {
        const status = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: {
              attached: boolean;
              rootKey: string | null;
              cwd: string;
              runtimeId: string | null;
              alive: boolean | null;
            };
          };
        }>(`${secondOrigin}/api/model/path/get`, {
          clientId: secondClientId,
          path: `/status/panes/${paneId}/terminal`
        });

        return status.result.value.attached && status.result.value.runtimeId ? status.result.value : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "recreated restored terminal status" }
    );
    expect(paneStatus).toMatchObject({
      attached: true,
      rootKey,
      alive: true
    });
    const recreatedRuntimeId = paneStatus.runtimeId;
    if (!recreatedRuntimeId) {
      throw new Error("expected recreated terminal runtime id");
    }
    expect(recreatedRuntimeId).not.toBe(firstRuntimeId);

    const recreatedHistory = await waitFor(
      async () => {
        const history = await postJson<{
          ok: true;
          result: {
            ok: true;
            value: {
              ok: true;
              runtimeId: string;
              data: string;
            };
          };
        }>(`${secondOrigin}/api/model/path/call`, {
          clientId: secondClientId,
          path: `/panes/${paneId}/terminal/history`,
          args: {
            maxBytes: 20_000
          }
        });

        return history.result.value.data.length > 0 ? history.result.value : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "recreated restored terminal history" }
    );
    expect(recreatedHistory.runtimeId).toBe(recreatedRuntimeId);
  } finally {
    // rootDir teardown happens in cleanupAppHandles (afterEach).
  }
}
