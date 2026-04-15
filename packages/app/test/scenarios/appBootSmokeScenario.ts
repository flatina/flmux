import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
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
    const workspaceAlphaStartPath = "/__flmux/internal/start?workspace=workspace.alpha";
    const workspaceBetaStartPath = "/__flmux/internal/start?workspace=workspace.beta";
    const workspaceAlphaStartUrl = `${appOrigin}${workspaceAlphaStartPath}`;
    const workspaceBetaStartUrl = `${appOrigin}${workspaceBetaStartPath}`;

    await waitFor(async () => {
      const targets = await fetchTargets(port);
      return targets.some((target) => target.url === workspaceAlphaStartUrl) ? true : null;
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

    const clientId = await waitForSingleClientId(appOrigin, "workspace beta client id");

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
          defaultBrowserPath: string;
        };
      };
    }>(`${appOrigin}/api/model/path/get`, {
      clientId,
      path: `/status/panes/${inspectorPaneId}/inspector`
    });
    expect(inspectorStatus.result.value).toMatchObject({
      workspaceId: "workspace.beta",
      defaultBrowserPath: workspaceBetaStartPath
    });

    const betaStartTargetCountBefore = (await fetchTargets(port))
      .filter((target) => target.url === workspaceBetaStartUrl)
      .length;

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
      return targets.filter((target) => target.url === workspaceBetaStartUrl).length > betaStartTargetCountBefore
        ? true
        : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "new workspace beta browser target" });
    await session.close();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}
