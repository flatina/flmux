import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { callJsonRpcIpc } from "../../src/main/ptyd/jsonRpcIpc";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import { findOwnedPtydLocksForRootDir } from "../support/ptydCleanup";
import {
  connectCdp,
  fetchJson,
  fetchTargets,
  launchFlmuxApp,
  postJson,
  stopAppWorkspaceDaemons,
  waitFor,
  waitForMainTarget,
  waitForSingleClientId
} from "../support/realAppSmokeSupport";

export async function runAppBootSmokeScenario(appHandles: AppProcessHandle[]) {
  await stopAppWorkspaceDaemons();
  const port = 9300 + Math.floor(Math.random() * 200);
  const sessionDir = await mkdtemp(resolve(tmpdir(), "flmux-session-"));
  const sessionFile = resolve(sessionDir, "session.json");
  const app = launchFlmuxApp(port, sessionFile);
  appHandles.push(app);

  try {
    const mainTarget = await waitForMainTarget(port, "main flmux target");
    const appOrigin = new URL(mainTarget.url).origin;
    const firstWorkspaceId = "workspace.1";
    const secondWorkspaceId = "workspace.2";
    const firstWorkspaceStartUrl = `${appOrigin}/__flmux/internal/start?workspace=${firstWorkspaceId}`;
    const secondWorkspaceStartUrl = `${appOrigin}/__flmux/internal/start?workspace=${secondWorkspaceId}`;

    await waitFor(async () => {
      const targets = await fetchTargets(port);
      return targets.some((target) => target.url === firstWorkspaceStartUrl) ? true : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "default start browser target" });

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
      return state.chipCount === 1 && state.workspaceTitle.includes("Workspace 1") ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "initial workbench state" });
    expect(initialState.title).toContain("Workspace 1");

    const initialClients = await fetchJson<{
      ok: true;
      clients: Array<{ workspace: { id: string; title: string } | null }>;
    }>(`${appOrigin}/api/clients`);
    expect(initialClients.ok).toBe(true);
    expect(initialClients.clients).toHaveLength(1);
    expect(initialClients.clients[0].workspace).toMatchObject({
      id: firstWorkspaceId,
      title: "Workspace 1"
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

    const clientId = await waitForSingleClientId(appOrigin, "workspace client id");

    const clickedWorkspaceCreate = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('[data-action="new-workspace"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(clickedWorkspaceCreate).toBe(true);

    const createdWorkspaceState = await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceTitle: string;
        chipCount: number;
        cowsayCount: number;
      }>(`(() => {
        const surface = document.querySelector('.workspace-surface--active');
        return {
          workspaceTitle: document.querySelector('#workspace-title')?.textContent ?? '',
          chipCount: document.querySelectorAll('.workspace-chip').length,
          cowsayCount: surface?.querySelectorAll('.cowsay-panel').length ?? 0
        };
      })()`);
      return state.chipCount === 2 && state.workspaceTitle.includes("Workspace 2") && state.cowsayCount >= 1
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "created workspace state" });
    expect(createdWorkspaceState.workspaceTitle).toContain("Workspace 2");

    await waitFor(async () => {
      const clients = await fetchJson<{
        ok: true;
        clients: Array<{ workspace: { id: string; title: string } | null }>;
      }>(`${appOrigin}/api/clients`);
      const workspace = clients.clients[0]?.workspace;
      return workspace?.id === secondWorkspaceId ? workspace : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace 2 client status" });

    await waitFor(async () => {
      const targets = await fetchTargets(port);
      return targets.some((target) => target.url === secondWorkspaceStartUrl) ? true : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace 2 start browser target" });

    const switchedBackToOne = await session.evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('.workspace-chip'))
        .find((candidate) => candidate.textContent?.includes('Workspace 1'));
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(switchedBackToOne).toBe(true);

    await waitFor(async () => {
      const workspaceTitle = await session.evaluate<string>(
        `document.querySelector('#workspace-title')?.textContent ?? ''`
      );
      return workspaceTitle.includes("Workspace 1") ? workspaceTitle : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 1 title" });

    const switchedToTwo = await session.evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('.workspace-chip'))
        .find((candidate) => candidate.textContent?.includes('Workspace 2'));
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(switchedToTwo).toBe(true);

    await waitFor(async () => {
      const workspaceTitle = await session.evaluate<string>(
        `document.querySelector('#workspace-title')?.textContent ?? ''`
      );
      return workspaceTitle.includes("Workspace 2") ? workspaceTitle : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 title" });

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
        state.workspaceId === secondWorkspaceId &&
        state.appTitle === "flmux" &&
        state.paneCount.length > 0 &&
        state.subscription === "*"
      )
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector snapshot on workspace 2" });

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
    }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector pane id on workspace 2" });

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
          defaultBrowserPath: string;
        };
      };
    }>(`${appOrigin}/api/model/path/get`, {
      clientId,
      path: `/status/panes/${inspectorPaneId}/inspector`
    });
    expect(inspectorStatus.result.value).toMatchObject({
      workspaceId: secondWorkspaceId,
      defaultBrowserPath: `/__flmux/internal/start?workspace=${secondWorkspaceId}`
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

    const scratchpadPaneId = await waitFor(async () => {
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

      return Object.values(panes.result.value).find((pane) => pane.kind === "scratchpad")?.id ?? null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "scratchpad pane id on workspace 2" });

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
      return state.workspaceId === secondWorkspaceId && state.note === "" ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "scratchpad panel on workspace 2" });

    const scratchpadMarker = `scratchpad-${crypto.randomUUID()}`;
    const updatedScratchpad = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: string;
      };
    }>(`${appOrigin}/api/model/path/set`, {
      clientId,
      path: `/panes/${scratchpadPaneId}/scratchpad/note`,
      value: scratchpadMarker
    });
    expect(updatedScratchpad.result.value).toBe(scratchpadMarker);

    await waitFor(async () => {
      const state = await session.evaluate<{
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
    }, { timeoutMs: 20_000, intervalMs: 250, label: "scratchpad note update" });

    const secondWorkspaceStartTargetCountBefore = (await fetchTargets(port))
      .filter((target) => target.url === secondWorkspaceStartUrl)
      .length;

    const clickedBrowser = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('[data-action="new-browser"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(clickedBrowser).toBe(true);

    await waitFor(async () => {
      const targets = await fetchTargets(port);
      return targets.filter((target) => target.url === secondWorkspaceStartUrl).length > secondWorkspaceStartTargetCountBefore
        ? true
        : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "new workspace 2 browser target" });

    const terminalPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: {
          paneId: string;
        };
      };
    }>(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: "/panes/new",
      args: {
        kind: "terminal",
        cwd: ".",
        place: "right",
        autoCreate: true
      }
    });
    const terminalPaneId = terminalPane.result.value.paneId;

    await waitFor(async () => {
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
      }>(`${appOrigin}/api/model/path/get`, {
        clientId,
        path: `/status/panes/${terminalPaneId}/terminal`
      });

      return status.result.value.attached && status.result.value.rootKey && status.result.value.runtimeId
        ? status.result.value
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal attach" });

    const closedWorkspace = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('[data-action="close-workspace"][data-workspace-id="${secondWorkspaceId}"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(closedWorkspace).toBe(true);

    await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceTitle: string;
        chipCount: number;
        surfaceCount: number;
        closedWorkspacePresent: boolean;
      }>(`(() => ({
        workspaceTitle: document.querySelector('#workspace-title')?.textContent ?? '',
        chipCount: document.querySelectorAll('.workspace-chip').length,
        surfaceCount: document.querySelectorAll('.workspace-surface').length,
        closedWorkspacePresent: Boolean(document.querySelector('.workspace-surface[data-workspace-id="${secondWorkspaceId}"]'))
      }))()`);
      return (
        state.chipCount === 1 &&
        state.surfaceCount === 1 &&
        !state.closedWorkspacePresent &&
        state.workspaceTitle.includes("Workspace 1")
      )
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 close fallback to workspace 1" });

    await waitFor(async () => {
      const clients = await fetchJson<{
        ok: true;
        clients: Array<{ workspace: { id: string; title: string } | null }>;
      }>(`${appOrigin}/api/clients`);
      const workspace = clients.clients[0]?.workspace;
      return workspace?.id === firstWorkspaceId ? workspace : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace 1 client status after close" });

    await waitFor(async () => {
      try {
        const saved = (await Bun.file(sessionFile).json()) as {
          activeWorkspaceId: string;
          workspaces: Record<string, unknown>;
        };
        return (
          saved.activeWorkspaceId === firstWorkspaceId &&
          firstWorkspaceId in saved.workspaces &&
          !(secondWorkspaceId in saved.workspaces)
        )
          ? true
          : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 10_000, intervalMs: 100, label: "workspace close persisted session file" });

    const secondWorkspaceRootDir = resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      workspaceRootDirName(secondWorkspaceId)
    );

    await waitFor(async () => {
      const locks = await findOwnedPtydLocksForRootDir(secondWorkspaceRootDir);
      if (locks.length === 0) {
        return true;
      }

      const rootStatuses = await Promise.all(
        locks.map(async (lock) => {
          try {
            return await callJsonRpcIpc<{ runtimeCount: number }>(
              lock.controlIpcPath,
              "root.status",
              undefined,
              2_000
            );
          } catch {
            return null;
          }
        })
      );

      return rootStatuses.every((status) => status === null || status.runtimeCount === 0)
        ? true
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal cleanup after close" });

    await session.close();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

function workspaceRootDirName(workspaceId: string) {
  return workspaceId.replace(/[^A-Za-z0-9_-]+/g, "-");
}
