import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PtydClient } from "../../src/main/ptyd/client";
import { PtydLockFile } from "../../src/main/ptyd/lockFile";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import {
  connectCdp,
  fetchJson,
  fetchTargets,
  killMainProcessOnly,
  launchFlmuxApp,
  postJson,
  stopAppWorkspaceDaemons,
  waitFor,
  waitForMainTarget,
  waitForSingleClientId
} from "../support/realAppSmokeSupport";

export async function runTerminalRestartAdoptSmokeScenario(appHandles: AppProcessHandle[]) {
  await stopAppWorkspaceDaemons();
  const port = 9500 + Math.floor(Math.random() * 200);
  const secondPort = port + 300;
  const sessionDir = await mkdtemp(resolve(tmpdir(), "flmux-session-"));
  const sessionFile = resolve(sessionDir, "session.json");
  const firstApp = launchFlmuxApp(port, sessionFile);
  appHandles.push(firstApp);
  let secondSession: Awaited<ReturnType<typeof connectCdp>> | null = null;

  try {
    const firstMainTarget = await waitForMainTarget(port, "first main flmux target");
    const firstOrigin = new URL(firstMainTarget.url).origin;
    const firstClientId = await waitForSingleClientId(firstOrigin, "first client id");

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

    const created = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: {
          ok: true;
          rootKey: string;
          runtimeId: string;
        };
      };
    }>(`${firstOrigin}/api/model/path/call`, {
      clientId: firstClientId,
      path: `/panes/${paneId}/terminal/create`,
      args: {
        cwd: "."
      }
    });
    expect(created.result).toMatchObject({ ok: true });
    if (!created.result.ok) {
      throw new Error(`terminal/create failed: ${JSON.stringify(created.result)}`);
    }
    const rootKey = created.result.value.rootKey;
    const runtimeId = created.result.value.runtimeId;
    const rootDir = resolve(import.meta.dir, "..", "..", "workspace-alpha");

    const marker = `flmux-restart-${crypto.randomUUID()}`;
    await postJson<{
      ok: true;
      result: {
        ok: true;
        value: {
          ok: true;
          accepted: boolean;
        };
      };
    }>(`${firstOrigin}/api/model/path/call`, {
      clientId: firstClientId,
      path: `/panes/${paneId}/terminal/write`,
      args: {
        data: `echo ${marker}\r`
      }
    });

    const browserPane = await postJson<{
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
        kind: "browser",
        title: "Form",
        url: "/fixtures/form",
        place: "right"
      }
    });
    const browserPaneId = browserPane.result.value.paneId;

    const cowsayPane = await postJson<{
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
        kind: "cowsay",
        title: "Persisted Probe",
        place: "right"
      }
    });
    const cowsayPaneId = cowsayPane.result.value.paneId;

    const inspectorPane = await postJson<{
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
        kind: "inspector",
        title: "Persisted Inspector",
        subscription: "inspector.*",
        place: "right"
      }
    });
    const inspectorPaneId = inspectorPane.result.value.paneId;

    const inspectorState = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          subscription: string;
        };
      };
    }>(`${firstOrigin}/api/model/path/get`, {
      clientId: firstClientId,
      path: `/panes/${inspectorPaneId}/inspector`
    });
    expect(inspectorState.result.value).toEqual({
      subscription: "inspector.*"
    });

    const scratchpadMarker = `scratchpad-${crypto.randomUUID()}`;
    const scratchpadPane = await postJson<{
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
        kind: "scratchpad",
        title: "Persisted Scratchpad",
        place: "right"
      }
    });
    const scratchpadPaneId = scratchpadPane.result.value.paneId;

    const updatedScratchpad = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: string;
      };
    }>(`${firstOrigin}/api/model/path/set`, {
      clientId: firstClientId,
      path: `/panes/${scratchpadPaneId}/scratchpad/note`,
      value: scratchpadMarker
    });
    expect(updatedScratchpad.result.value).toBe(scratchpadMarker);

    const scratchpadState = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          note: string;
        };
      };
    }>(`${firstOrigin}/api/model/path/get`, {
      clientId: firstClientId,
      path: `/panes/${scratchpadPaneId}/scratchpad`
    });
    expect(scratchpadState.result.value.note).toBe(scratchpadMarker);

    const scratchpadStatus = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          noteLength: number;
        };
      };
    }>(`${firstOrigin}/api/model/path/get`, {
      clientId: firstClientId,
      path: `/status/panes/${scratchpadPaneId}/scratchpad`
    });
    expect(scratchpadStatus.result.value.noteLength).toBe(scratchpadMarker.length);

    await waitFor(async () => {
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
          };
        };
      }>(`${firstOrigin}/api/model/path/get`, {
        clientId: firstClientId,
        path: `/status/panes/${paneId}/terminal`
      });

      return status.result.value.attached && status.result.value.rootKey === rootKey
        ? status.result.value
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "attached terminal before restart" });

    const ptydClient = new PtydClient(rootKey, rootDir);
    try {
      await ptydClient.ensureStarted();
      const listed = await ptydClient.list();
      expect(listed.find((runtime) => runtime.runtimeId === runtimeId)).toMatchObject({
        runtimeId,
        ownerPaneId: paneId
      });
    } finally {
      ptydClient.dispose();
    }

    await waitFor(async () => {
      try {
        const saved = await Bun.file(sessionFile).text();
        return (
          saved.includes("\"version\": 1") &&
          saved.includes(paneId) &&
          saved.includes(browserPaneId) &&
          saved.includes(cowsayPaneId) &&
          saved.includes(inspectorPaneId) &&
          saved.includes(scratchpadPaneId)
        )
          ? true
          : null;
      } catch {
        return null;
      }
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: "persisted session file"
    });

    await killMainProcessOnly(firstApp.process);
    await waitFor(async () => {
      try {
        await fetchTargets(port);
        return null;
      } catch {
        return true;
      }
    }, { timeoutMs: 20_000, intervalMs: 250, label: "first app shutdown" });
    const lock = await new PtydLockFile(rootKey).load();
    expect(lock?.rootKey).toBe(rootKey);

    const secondApp = launchFlmuxApp(secondPort, sessionFile);
    appHandles.push(secondApp);

    const secondMainTarget = await waitForMainTarget(secondPort, "second main flmux target");
    const secondOrigin = new URL(secondMainTarget.url).origin;
    const connectedSecondSession = await connectCdp(secondMainTarget.webSocketDebuggerUrl!);
    secondSession = connectedSecondSession;
    await connectedSecondSession.send("Runtime.enable");
    const secondClientId = await waitForSingleClientId(secondOrigin, "second client id");

    const paneState = await waitFor(async () => {
      const state = await postJson<{
        ok: true;
        result: {
          ok: true;
          found: boolean;
          value: {
            cwd: string;
          } | null;
        };
      }>(`${secondOrigin}/api/model/path/get`, {
        clientId: secondClientId,
        path: `/panes/${paneId}/terminal`
      });

      return state.result.found ? state.result.value : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "restored terminal pane state" });
    expect(paneState).toEqual({
      cwd: expect.stringContaining("workspace-alpha")
    });

    const paneStatus = await postJson<{
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
          commandCount: number | null;
          createdAt: string | null;
          updatedAt: string | null;
        };
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/status/panes/${paneId}/terminal`
    });
    expect(paneStatus.result.value).toMatchObject({
      attached: true,
      rootKey,
      runtimeId,
      alive: true
    });

    const restoredHistory = await waitFor(async () => {
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

      return history.result.value.data.includes(marker) ? history.result.value : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "restored terminal history" });
    expect(restoredHistory.runtimeId).toBe(runtimeId);
    expect(restoredHistory.data).toContain(marker);

    const restoredBrowser = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: string;
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/status/panes/${browserPaneId}/browser/url`
    });
    expect(restoredBrowser.result.value).toBe(`${secondOrigin}/fixtures/form`);

    const restoredCowsayPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          id: string;
          kind: string;
          title: string;
          active: boolean;
        };
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/status/panes/${cowsayPaneId}`
    });
    expect(restoredCowsayPane.result.value).toMatchObject({
      id: cowsayPaneId,
      kind: "cowsay",
      title: "Persisted Probe"
    });

    const restoredInspectorPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          id: string;
          kind: string;
          title: string;
          active: boolean;
        };
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/status/panes/${inspectorPaneId}`
    });
    expect(restoredInspectorPane.result.value).toMatchObject({
      id: inspectorPaneId,
      kind: "inspector",
      title: "Persisted Inspector"
    });

    const restoredInspectorState = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          subscription: string;
        };
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/panes/${inspectorPaneId}/inspector`
    });
    expect(restoredInspectorState.result.value).toEqual({
      subscription: "inspector.*"
    });

    const restoredScratchpadPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          id: string;
          kind: string;
          title: string;
          active: boolean;
        };
      };
    }>(`${secondOrigin}/api/model/path/get`, {
      clientId: secondClientId,
      path: `/status/panes/${scratchpadPaneId}`
    });
    expect(restoredScratchpadPane.result.value).toMatchObject({
      id: scratchpadPaneId,
      kind: "scratchpad",
      title: "Persisted Scratchpad"
    });

    const restoredCowsay = await waitFor(async () => {
      const state = await connectedSecondSession.evaluate<{
        cowsayCount: number;
        probeTitle: string;
      }>(`(() => {
        const surface = document.querySelector('.workspace-surface--active');
        return {
          cowsayCount: surface?.querySelectorAll('.cowsay-panel').length ?? 0,
          probeTitle: surface?.querySelector('.cowsay-panel strong')?.textContent ?? ''
        };
      })()`);
      return state.cowsayCount >= 2 && state.probeTitle.includes("cowsay probe") ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "restored cowsay panel" });
    expect(restoredCowsay.cowsayCount).toBeGreaterThanOrEqual(2);

    const restoredScratchpad = await waitFor(async () => {
      const state = await connectedSecondSession.evaluate<{
        note: string;
        counter: string;
      }>(`(() => {
        const surface = document.querySelector('.workspace-surface--active');
        const panel = surface?.querySelector('.scratchpad-panel');
        return {
          note: panel?.querySelector('textarea')?.value ?? '',
          counter: panel?.querySelector('[data-role="counter"]')?.textContent ?? ''
        };
      })()`);
      return state.note === scratchpadMarker && state.counter.includes("chars") ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "restored scratchpad note" });
    expect(restoredScratchpad.note).toBe(scratchpadMarker);

    await waitFor(async () => {
      const targets = await fetchTargets(secondPort);
      return targets.some((target) => target.url === `${secondOrigin}/fixtures/form`) ? true : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "restored form browser target" });
  } finally {
    if (secondSession) {
      await secondSession.close();
    }
    await rm(sessionDir, { recursive: true, force: true });
  }
}
