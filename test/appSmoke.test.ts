import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PtydClient } from "../src/main/ptyd/client";
import { PtydLockFile } from "../src/main/ptyd/lockFile";
import { stopOwnedPtydDaemonsForRootDir } from "./support/ptydCleanup";
import { waitFor } from "./support/waitFor";

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const appHandles: Array<{ process: Bun.Subprocess<"ignore", "pipe", "pipe"> }> = [];

afterEach(async () => {
  while (appHandles.length > 0) {
    const handle = appHandles.pop();
    if (!handle) {
      continue;
    }

    await killProcessTree(handle.process);
  }
});

describe("flmux app smoke", () => {
  it(
    "boots the real app, switches workspace, and opens a browser fixture",
    async () => {
      await stopAppWorkspaceDaemons();
      const port = 9300 + Math.floor(Math.random() * 200);
      const sessionDir = await mkdtemp(resolve(tmpdir(), "flmux-session-"));
      const sessionFile = resolve(sessionDir, "session.json");
      const app = launchFlmuxApp(port, sessionFile);
      appHandles.push(app);

      try {
        const mainTarget = await waitFor(async () => {
          const targets = await fetchTargets(port);
          return targets.find((target) => target.url.endsWith("/") && target.webSocketDebuggerUrl) ?? null;
        }, { timeoutMs: 30_000, intervalMs: 500, label: "main flmux target" });
        const appOrigin = new URL(mainTarget.url).origin;

        await waitFor(async () => {
          const targets = await fetchTargets(port);
          return targets.some((target) => target.url.endsWith("/fixtures/counter")) ? true : null;
        }, { timeoutMs: 20_000, intervalMs: 500, label: "default counter browser target" });

        const session = await connectCdp(mainTarget.webSocketDebuggerUrl!);
        await session.send("Runtime.enable");

        const initialState = await waitFor(async () => {
          const state = await session.evaluate<{
            title: string;
            workspaceTitle: string;
            chipCount: number;
          }>(`(() => ({
            title: document.title,
            workspaceTitle: document.querySelector('#workspace-title')?.textContent ?? '',
            chipCount: document.querySelectorAll('.workspace-chip').length
          }))()`);
          return state.chipCount >= 2 && state.workspaceTitle.includes("Workspace Alpha") ? state : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "initial workbench state" });
        expect(initialState.title).toContain("Workspace Alpha");

        const initialClients = await fetchJson<{
          ok: true;
          clients: Array<{ workspace: { id: string; title: string } | null }>;
        }>(`${appOrigin}/api/clients`);
        expect(initialClients.ok).toBe(true);
        expect(initialClients.clients).toHaveLength(1);
        expect(initialClients.clients[0].workspace).toMatchObject({
          id: "workspace.alpha"
        });

        const initialCowsay = await waitFor(async () => {
          const state = await session.evaluate<{
            cowsayCount: number;
            probeTitle: string;
          }>(`(() => {
            const surface = document.querySelector('.workspace-surface--active');
            return {
              cowsayCount: surface?.querySelectorAll('.cowsay-panel').length ?? 0,
              probeTitle: surface?.querySelector('.cowsay-panel strong')?.textContent ?? ''
            };
          })()`);
          return state.cowsayCount >= 1 && state.probeTitle.includes("cowsay probe") ? state : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "default cowsay panel" });
        expect(initialCowsay.cowsayCount).toBeGreaterThanOrEqual(1);

        const clickedWorkspace = await session.evaluate<boolean>(`(() => {
          const button = Array.from(document.querySelectorAll('.workspace-chip'))
            .find((candidate) => candidate.textContent?.includes('Workspace Beta'));
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(clickedWorkspace).toBe(true);

        await waitFor(async () => {
          const workspaceTitle = await session.evaluate<string>(
            `document.querySelector('#workspace-title')?.textContent ?? ''`
          );
          return workspaceTitle.includes("Workspace Beta") ? workspaceTitle : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace beta title" });

        await waitFor(async () => {
          const clients = await fetchJson<{
            ok: true;
            clients: Array<{ workspace: { id: string; title: string } | null }>;
          }>(`${appOrigin}/api/clients`);
          const workspace = clients.clients[0]?.workspace;
          return workspace?.id === "workspace.beta" ? workspace : null;
        }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace beta client status" });

        const clientId = await waitFor(async () => {
          const clients = await fetchJson<{
            ok: true;
            clients: Array<{ clientId: string; workspace: { id: string; title: string } | null }>;
          }>(`${appOrigin}/api/clients`);
          return clients.clients[0]?.clientId ?? null;
        }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace beta client id" });

        const clickedCowsay = await session.evaluate<boolean>(`(() => {
          const button = document.querySelector('[data-action="new-cowsay"]');
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(clickedCowsay).toBe(true);

        await waitFor(async () => {
          const state = await session.evaluate<{ cowsayCount: number }>(`(() => {
            const surface = document.querySelector('.workspace-surface--active');
            return {
              cowsayCount: surface?.querySelectorAll('.cowsay-panel').length ?? 0
            };
          })()`);
          return state.cowsayCount >= 2 ? state : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "new cowsay panel on workspace beta" });

        const clickedInspector = await session.evaluate<boolean>(`(() => {
          const button = document.querySelector('[data-action="new-inspector"]');
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(clickedInspector).toBe(true);

        await waitFor(async () => {
          const state = await session.evaluate<{
            workspaceId: string;
            appTitle: string;
            paneCount: string;
            subscription: string;
          }>(`(() => {
            const surface = document.querySelector('.workspace-surface--active');
            const panel = surface?.querySelector('.inspector-panel');
            return {
              workspaceId: panel?.querySelector('[data-role="workspace-id"]')?.textContent ?? '',
              appTitle: panel?.querySelector('[data-role="app-title"]')?.textContent ?? '',
              paneCount: panel?.querySelector('[data-role="pane-count"]')?.textContent ?? '',
              subscription: panel?.querySelector('[data-role="subscription"]')?.textContent ?? ''
            };
          })()`);
          return (
            state.workspaceId === "workspace.beta" &&
            state.appTitle === "flmux" &&
            state.paneCount.length > 0 &&
            state.subscription === "*"
          )
            ? state
            : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector snapshot on workspace beta" });

        const inspectorPaneId = await waitFor(async () => {
          const panes = await postJson<{
            ok: true;
            result: {
              ok: true;
              found: true;
              value: Record<string, { id: string; kind: string; title: string; active: boolean }>;
            };
          }>(`${appOrigin}/api/model/path/get`, {
            clientId,
            path: "/status/panes"
          });

          return Object.values(panes.result.value).find((pane) => pane.kind === "inspector")?.id ?? null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector pane id on workspace beta" });

        const inspectorState = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: {
              subscription: string;
            };
          };
        }>(`${appOrigin}/api/model/path/get`, {
          clientId,
          path: `/panes/${inspectorPaneId}/inspector`
        });
        expect(inspectorState.result.value).toEqual({
          subscription: "*"
        });

        const inspectorStatus = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: {
              workspaceId: string;
              rootDir: string;
              defaultFixture: string;
            };
          };
        }>(`${appOrigin}/api/model/path/get`, {
          clientId,
          path: `/status/panes/${inspectorPaneId}/inspector`
        });
        expect(inspectorStatus.result.value).toMatchObject({
          workspaceId: "workspace.beta",
          defaultFixture: "form"
        });

        const inspectorWriteBlocked = await postJson<{
          ok: true;
          result: {
            ok: false;
            code: string;
            error: string;
          };
        }>(`${appOrigin}/api/model/path/set`, {
          clientId,
          path: `/panes/${inspectorPaneId}/inspector/subscription`,
          value: "other.*"
        });
        expect(inspectorWriteBlocked.result).toEqual({
          ok: false,
          code: "NOT_WRITABLE",
          error: "Path is not writable"
        });

        const pingedInspector = await session.evaluate<boolean>(`(() => {
          const surface = document.querySelector('.workspace-surface--active');
          const button = surface?.querySelector('.inspector-panel [data-action="ping"]');
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(pingedInspector).toBe(true);

        await waitFor(async () => {
          const state = await session.evaluate<{ lastEvent: string }>(`(() => {
            const surface = document.querySelector('.workspace-surface--active');
            const panel = surface?.querySelector('.inspector-panel');
            return {
              lastEvent: panel?.querySelector('[data-role="last-event"]')?.textContent ?? ''
            };
          })()`);
          return state.lastEvent === "inspector.ping" ? state : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector ping event" });

        const clickedScratchpad = await session.evaluate<boolean>(`(() => {
          const button = document.querySelector('[data-action="new-scratchpad"]');
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(clickedScratchpad).toBe(true);

        await waitFor(async () => {
          const state = await session.evaluate<{
            workspaceId: string;
            note: string;
          }>(`(() => {
            const surface = document.querySelector('.workspace-surface--active');
            const panel = surface?.querySelector('.scratchpad-panel');
            return {
              workspaceId: panel?.querySelector('[data-role="workspace-id"]')?.textContent ?? '',
              note: panel?.querySelector('textarea')?.value ?? ''
            };
          })()`);
          return state.workspaceId === "workspace.beta" && state.note === "" ? state : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "scratchpad panel on workspace beta" });

        const clickedFixture = await session.evaluate<boolean>(`(() => {
          const button = document.querySelector('[data-fixture="form"]');
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          button.click();
          return true;
        })()`);
        expect(clickedFixture).toBe(true);

        await waitFor(async () => {
          const targets = await fetchTargets(port);
          return targets.some((target) => target.url.endsWith("/fixtures/form")) ? true : null;
        }, { timeoutMs: 20_000, intervalMs: 500, label: "form browser target" });
        await session.close();
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    },
    60_000
  );

  it(
    "reattaches surviving terminal runtimes after flmux restart",
    async () => {
      await stopAppWorkspaceDaemons();
      const port = 9500 + Math.floor(Math.random() * 200);
      const secondPort = port + 300;
      const sessionDir = await mkdtemp(resolve(tmpdir(), "flmux-session-"));
      const sessionFile = resolve(sessionDir, "session.json");
      const firstApp = launchFlmuxApp(port, sessionFile);
      appHandles.push(firstApp);
      let secondSession: Awaited<ReturnType<typeof connectCdp>> | null = null;

      try {
        const firstMainTarget = await waitFor(async () => {
          const targets = await fetchTargets(port);
          return targets.find((target) => target.url.endsWith("/") && target.webSocketDebuggerUrl) ?? null;
        }, { timeoutMs: 30_000, intervalMs: 500, label: "first main flmux target" });
        const firstOrigin = new URL(firstMainTarget.url).origin;
        const firstClientId = await waitFor(async () => {
          const clients = await fetchJson<{
            ok: true;
            clients: Array<{ clientId: string }>;
          }>(`${firstOrigin}/api/clients`);
          return clients.clients[0]?.clientId ?? null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "first client id" });

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
        const rootDir = resolve(import.meta.dir, "..", "workspace-alpha");

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

        const secondMainTarget = await waitFor(async () => {
          const targets = await fetchTargets(secondPort);
          return targets.find((target) => target.url.endsWith("/") && target.webSocketDebuggerUrl) ?? null;
        }, { timeoutMs: 30_000, intervalMs: 500, label: "second main flmux target" });
        const secondOrigin = new URL(secondMainTarget.url).origin;
        const connectedSecondSession = await connectCdp(secondMainTarget.webSocketDebuggerUrl!);
        secondSession = connectedSecondSession;
        await connectedSecondSession.send("Runtime.enable");
        const secondClientId = await waitFor(async () => {
          const clients = await fetchJson<{
            ok: true;
            clients: Array<{ clientId: string }>;
          }>(`${secondOrigin}/api/clients`);
          return clients.clients[0]?.clientId ?? null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "second client id" });

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
    },
    90_000
  );
});

function launchFlmuxApp(remoteDebuggingPort: number, sessionFile?: string) {
  const appProcess = Bun.spawn({
    cmd: [resolveBunCommand(), "run", "dev"],
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      BUNITE_REMOTE_DEBUGGING_PORT: String(remoteDebuggingPort),
      FLMUX_DEV_MODE: "1",
      FLMUX_HIDDEN_WINDOW: "1",
      ...(sessionFile ? { FLMUX_SESSION_FILE: sessionFile } : {})
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  return { process: appProcess };
}

async function fetchTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000)
  });
  if (!response.ok) {
    throw new Error(`CDP target list failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<CdpTarget[]>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function connectCdp(url: string) {
  const websocket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to connect to CDP target ${url}`));
    };
    const cleanup = () => {
      websocket.removeEventListener("open", onOpen);
      websocket.removeEventListener("error", onError);
    };

    websocket.addEventListener("open", onOpen);
    websocket.addEventListener("error", onError);
  });

  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.id !== "number") {
      return;
    }

    const callback = pending.get(message.id);
    if (!callback) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      callback.reject(new Error(message.error.message ?? "Unknown CDP error"));
      return;
    }

    callback.resolve(message.result);
  });

  return {
    async send(method: string, params: Record<string, unknown> = {}) {
      const id = ++nextId;
      const payload = JSON.stringify({
        id,
        method,
        params
      });

      const result = await new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        websocket.send(payload);
      });

      return result;
    },
    async evaluate<T>(expression: string): Promise<T> {
      const result = (await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      })) as {
        result?: { value?: T };
        exceptionDetails?: { text?: string };
      };

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
      }

      return result.result?.value as T;
    },
    async close() {
      websocket.close();
      await new Promise<void>((resolve) => {
        if (websocket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        websocket.addEventListener("close", () => resolve(), { once: true });
      });
    }
  };
}

async function killProcessTree(processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  if (processHandle.killed || processHandle.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = Bun.spawn({
      cmd: ["taskkill", "/PID", String(processHandle.pid), "/T", "/F"],
      stdout: "ignore",
      stderr: "ignore"
    });
    await killer.exited;
    return;
  }

  processHandle.kill();
  await processHandle.exited;
}

async function killMainProcessOnly(processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  if (processHandle.killed || processHandle.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = Bun.spawn({
      cmd: ["taskkill", "/PID", String(processHandle.pid), "/F"],
      stdout: "ignore",
      stderr: "ignore"
    });
    await killer.exited;
    return;
  }

  processHandle.kill("SIGKILL");
  await processHandle.exited;
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}

async function stopAppWorkspaceDaemons() {
  await stopOwnedPtydDaemonsForRootDir(resolve(import.meta.dir, "..", "workspace-alpha"));
  await stopOwnedPtydDaemonsForRootDir(resolve(import.meta.dir, "..", "workspace-beta"));
}
