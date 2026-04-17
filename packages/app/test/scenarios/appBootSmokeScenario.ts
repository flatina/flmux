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
  resolveAppInstallRoot,
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
        workspacePanelCount: number;
      }>(`(() => ({
        title: document.title,
        workspacePanelCount: document.querySelectorAll('.workspace-panel[data-workspace-id="${firstWorkspaceId}"]').length
      }))()`);
      return state.workspacePanelCount === 1 && state.title.includes("Workspace 1") ? state : null;
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
        const panel = document.querySelector('.workspace-panel[data-workspace-id="${firstWorkspaceId}"]');
        return {
          cowsayCount: panel?.querySelectorAll('.cowsay-panel').length ?? 0,
          probeTitle: panel?.querySelector('.cowsay-panel strong')?.textContent ?? ''
        };
      })()`);
      return state.cowsayCount >= 1 && state.probeTitle.includes("cowsay probe") ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "default cowsay panel" });
    expect(initialCowsay.cowsayCount).toBeGreaterThanOrEqual(1);

    const clientId = await waitForSingleClientId(appOrigin, "workspace client id");

    const outerAddClicked = await session.evaluate<boolean>(`(() => {
      const tabs = document.querySelectorAll('.dv-tabs-and-actions-container');
      for (const container of tabs) {
        if (container.closest('.workspace-panel')) {
          continue;
        }
        const button = container.querySelector('.header-action__btn[title="New Workspace"]');
        if (button instanceof HTMLButtonElement) {
          button.click();
          return true;
        }
      }
      return false;
    })()`);
    expect(outerAddClicked).toBe(true);

    const createdWorkspaceState = await waitFor(async () => {
      const state = await session.evaluate<{
        title: string;
        workspacePanelCount: number;
        secondWorkspacePresent: boolean;
        cowsayCount: number;
      }>(`(() => {
        const second = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"]');
        return {
          title: document.title,
          workspacePanelCount: document.querySelectorAll('.workspace-panel').length,
          secondWorkspacePresent: Boolean(second),
          cowsayCount: second?.querySelectorAll('.cowsay-panel').length ?? 0
        };
      })()`);
      return (
        state.secondWorkspacePresent &&
        state.workspacePanelCount === 2 &&
        state.title.includes("Workspace 2") &&
        state.cowsayCount >= 1
      )
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "created workspace state" });
    expect(createdWorkspaceState.title).toContain("Workspace 2");

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
      const tab = Array.from(document.querySelectorAll('.dv-tab'))
        .find((candidate) => !candidate.closest('.workspace-panel') && candidate.textContent?.includes('Workspace 1'));
      if (!(tab instanceof HTMLElement)) {
        return false;
      }
      tab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      return true;
    })()`);
    expect(switchedBackToOne).toBe(true);

    await waitFor(async () => {
      const title = await session.evaluate<string>(`document.title`);
      return title.includes("Workspace 1") ? title : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 1 title after switch" });

    const switchedToTwo = await session.evaluate<boolean>(`(() => {
      const tab = Array.from(document.querySelectorAll('.dv-tab'))
        .find((candidate) => !candidate.closest('.workspace-panel') && candidate.textContent?.includes('Workspace 2'));
      if (!(tab instanceof HTMLElement)) {
        return false;
      }
      tab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      return true;
    })()`);
    expect(switchedToTwo).toBe(true);

    await waitFor(async () => {
      const title = await session.evaluate<string>(`document.title`);
      return title.includes("Workspace 2") ? title : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 title after switch" });

    const innerAddClicked = await session.evaluate<boolean>(`(() => {
      const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"]');
      const container = panel?.querySelector('.dv-tabs-and-actions-container');
      const button = container?.querySelector('.header-action__btn');
      if (button instanceof HTMLButtonElement) {
        button.click();
        return true;
      }
      return false;
    })()`);
    expect(innerAddClicked).toBe(true);

    const popupKinds = await session.evaluate<string[]>(`(() => {
      const popup = document.querySelector('.header-action-popup');
      return popup
        ? Array.from(popup.querySelectorAll('.header-action-popup__item')).map((el) => el.getAttribute('data-kind') ?? '')
        : [];
    })()`);
    for (const expected of ["browser", "terminal", "cowsay", "inspector", "scratchpad"]) {
      expect(popupKinds).toContain(expected);
    }

    const inspectorPicked = await session.evaluate<boolean>(`(() => {
      const popup = document.querySelector('.header-action-popup');
      const item = popup?.querySelector('[data-kind="inspector"]');
      if (item instanceof HTMLButtonElement) {
        item.click();
        return true;
      }
      return false;
    })()`);
    expect(inspectorPicked).toBe(true);

    const inspectorPaneId = await waitFor(async () => {
      const panes = await postJson<{
        ok: true;
        result: {
          ok: true;
          found: true;
          value: Record<string, { id: string; kind: string }>;
        };
      }>(`${appOrigin}/api/model/path/get`, {
        clientId,
        path: "/status/panes"
      });
      return Object.values(panes.result.value).find((pane) => pane.kind === "inspector")?.id ?? null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector pane id after popup pick" });

    await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceId: string;
        appTitle: string;
        paneCount: string;
        subscription: string;
      }>(`(() => {
        const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"] .inspector-panel');
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

    const inspectorState = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: { subscription: string };
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
      const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"] .inspector-panel');
      const button = panel?.querySelector('[data-action="ping"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(pingedInspector).toBe(true);

    await waitFor(async () => {
      const state = await session.evaluate<{ lastEvent: string }>(`(() => {
        const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"] .inspector-panel');
        return {
          lastEvent: panel?.querySelector('[data-role="last-event"]')?.textContent ?? ''
        };
      })()`);
      return state.lastEvent === "inspector.ping" ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "inspector ping event" });

    const scratchpadPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: { paneId: string };
      };
    }>(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: "/panes/new",
      args: { kind: "scratchpad", place: "right" }
    });
    const scratchpadPaneId = scratchpadPane.result.value.paneId;

    await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceId: string;
        note: string;
      }>(`(() => {
        const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"] .scratchpad-panel');
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
        const panel = document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"] .scratchpad-panel');
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

    await postJson(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: "/panes/new",
      args: { kind: "browser", place: "right" }
    });

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
        value: { paneId: string };
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
      const tab = Array.from(document.querySelectorAll('.dv-tab'))
        .find((candidate) => !candidate.closest('.workspace-panel') && candidate.textContent?.includes('Workspace 2'));
      if (!(tab instanceof HTMLElement)) {
        return false;
      }
      const close = tab.querySelector('.dv-default-tab-action');
      if (!(close instanceof HTMLElement)) {
        return false;
      }
      close.click();
      return true;
    })()`);
    expect(closedWorkspace).toBe(true);

    await waitFor(async () => {
      const state = await session.evaluate<{
        title: string;
        workspacePanelCount: number;
        secondPresent: boolean;
      }>(`(() => ({
        title: document.title,
        workspacePanelCount: document.querySelectorAll('.workspace-panel').length,
        secondPresent: Boolean(document.querySelector('.workspace-panel[data-workspace-id="${secondWorkspaceId}"]'))
      }))()`);
      return (
        state.workspacePanelCount === 1 &&
        !state.secondPresent &&
        state.title.includes("Workspace 1")
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
          version: number;
          outerLayout: { panels?: Record<string, unknown> } | null;
          workspaces: Record<string, unknown>;
        };
        if (saved.version !== 4) {
          return null;
        }
        if (!(firstWorkspaceId in saved.workspaces) || secondWorkspaceId in saved.workspaces) {
          return null;
        }
        const outerPanels = saved.outerLayout?.panels ?? null;
        if (!outerPanels || !(firstWorkspaceId in outerPanels) || secondWorkspaceId in outerPanels) {
          return null;
        }
        return true;
      } catch {
        return null;
      }
    }, { timeoutMs: 10_000, intervalMs: 100, label: "workspace close persisted session file" });

    const installRoot = resolveAppInstallRoot();

    // Closing workspace.2 kills its terminal pane; verify no runtime owned by
    // that pane remains on the install-scoped daemon. Filter by ownerPaneId
    // instead of total runtime count so sibling workspace terminals cannot
    // mask a leak of this specific runtime.
    await waitFor(async () => {
      const locks = await findOwnedPtydLocksForRootDir(installRoot);
      if (locks.length === 0) {
        return true;
      }

      const terminalLists = await Promise.all(
        locks.map(async (lock) => {
          try {
            return await callJsonRpcIpc<{ terminals: Array<{ ownerPaneId: string | null }> }>(
              lock.controlIpcPath,
              "terminal.list",
              undefined,
              2_000
            );
          } catch {
            return null;
          }
        })
      );

      return terminalLists.every((listing) =>
        listing === null ||
        listing.terminals.every((terminal) => terminal.ownerPaneId !== terminalPaneId)
      )
        ? true
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal runtime cleared from install-scoped daemon" });

    await session.close();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}
