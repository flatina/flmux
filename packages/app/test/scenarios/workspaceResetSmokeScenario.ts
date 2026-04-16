import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { callJsonRpcIpc } from "../../src/main/ptyd/jsonRpcIpc";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import { findOwnedPtydLocksForRootDir } from "../support/ptydCleanup";
import {
  connectCdp,
  fetchTargets,
  launchFlmuxApp,
  postJson,
  stopAppWorkspaceDaemons,
  waitFor,
  waitForMainTarget,
  waitForSingleClientId
} from "../support/realAppSmokeSupport";

export async function runWorkspaceResetSmokeScenario(appHandles: AppProcessHandle[]) {
  await stopAppWorkspaceDaemons();
  const port = 9700 + Math.floor(Math.random() * 200);
  const sessionDir = await mkdtemp(resolve(tmpdir(), "flmux-session-"));
  const sessionFile = resolve(sessionDir, "session.json");
  const app = launchFlmuxApp(port, sessionFile);
  appHandles.push(app);

  try {
    const mainTarget = await waitForMainTarget(port, "reset smoke main target");
    const appOrigin = new URL(mainTarget.url).origin;
    const secondWorkspaceId = "workspace.2";
    const secondWorkspaceStartUrl = `${appOrigin}/__flmux/internal/start?workspace=${secondWorkspaceId}`;
    const secondWorkspaceRootDir = resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      workspaceRootDirName(secondWorkspaceId)
    );

    const session = await connectCdp(mainTarget.webSocketDebuggerUrl!);
    await session.send("Runtime.enable");
    const clientId = await waitForSingleClientId(appOrigin, "reset smoke client id");

    const createdWorkspace = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('[data-action="new-workspace"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(createdWorkspace).toBe(true);

    await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceTitle: string;
        chipCount: number;
      }>(`(() => ({
        workspaceTitle: document.querySelector('#workspace-title')?.textContent ?? '',
        chipCount: document.querySelectorAll('.workspace-chip').length
      }))()`);
      return state.chipCount === 2 && state.workspaceTitle.includes("Workspace 2") ? state : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 active before reset" });

    await waitFor(async () => {
      const targets = await fetchTargets(port);
      return targets.some((target) => target.url === secondWorkspaceStartUrl) ? true : null;
    }, { timeoutMs: 20_000, intervalMs: 500, label: "workspace 2 start target before reset" });

    const retitledWorkspace = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: string;
      };
    }>(`${appOrigin}/api/model/path/set`, {
      clientId,
      path: "/title",
      value: "Workspace 2 Renamed"
    });
    expect(retitledWorkspace.result.value).toBe("Workspace 2 Renamed");

    await waitFor(async () => {
      const workspaceTitle = await session.evaluate<string>(
        `document.querySelector('#workspace-title')?.textContent ?? ''`
      );
      return workspaceTitle.includes("Workspace 2 Renamed") ? workspaceTitle : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "renamed workspace title before reset" });

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
        place: "right"
      }
    });
    const terminalPaneId = terminalPane.result.value.paneId;

    const createdRuntime = await postJson<{
      ok: true;
      result: {
        ok: true;
        value: {
          ok: true;
          rootKey: string;
          runtimeId: string;
        };
      };
    }>(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: `/panes/${terminalPaneId}/terminal/create`,
      args: {
        cwd: "."
      }
    });
    const runtimeId = createdRuntime.result.value.runtimeId;
    expect(runtimeId).toBeTruthy();

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

      return status.result.value.attached && status.result.value.runtimeId === runtimeId
        ? status.result.value
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal attach before reset" });

    const resetWorkspace = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('[data-action="reset"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(resetWorkspace).toBe(true);

    await waitFor(async () => {
      const state = await session.evaluate<{
        workspaceTitle: string;
        chipCount: number;
        cowsayCount: number;
        terminalCount: number;
        activeWorkspaceId: string | null;
      }>(`(() => {
        const surface = document.querySelector('.workspace-surface--active');
        return {
          workspaceTitle: document.querySelector('#workspace-title')?.textContent ?? '',
          chipCount: document.querySelectorAll('.workspace-chip').length,
          cowsayCount: surface?.querySelectorAll('.cowsay-panel').length ?? 0,
          terminalCount: surface?.querySelectorAll('.terminal-panel').length ?? 0,
          activeWorkspaceId: surface?.getAttribute('data-workspace-id') ?? null
        };
      })()`);
      return (
        state.activeWorkspaceId === secondWorkspaceId &&
        state.chipCount === 2 &&
        state.cowsayCount >= 1 &&
        state.terminalCount === 0 &&
        state.workspaceTitle.includes("Workspace 2")
      )
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 reset UI state" });

    const removedTerminalPane = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: boolean;
        value: unknown;
      };
    }>(`${appOrigin}/api/model/path/get`, {
      clientId,
      path: `/status/panes/${terminalPaneId}`
    });
    expect(removedTerminalPane.result).toEqual({
      ok: true,
      found: false,
      value: null
    });

    const workspaceStatus = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: {
          id: string;
          title: string;
          activePaneId: string | null;
          paneCount: number;
        };
      };
    }>(`${appOrigin}/api/model/path/get`, {
      clientId,
      path: "/status/workspace"
    });
    expect(workspaceStatus.result.value).toMatchObject({
      id: secondWorkspaceId,
      title: "Workspace 2",
      paneCount: 2
    });

    await waitFor(async () => {
      try {
        const saved = (await Bun.file(sessionFile).json()) as {
          activeWorkspaceId: string;
          workspaces: Record<string, { title?: string }>;
        };
        return (
          saved.activeWorkspaceId === secondWorkspaceId &&
          saved.workspaces[secondWorkspaceId]?.title === "Workspace 2"
        )
          ? true
          : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 10_000, intervalMs: 100, label: "workspace reset persisted session file" });

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
    }, { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 runtime cleanup after reset" });

    await session.close();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

function workspaceRootDirName(workspaceId: string) {
  return workspaceId.replace(/[^A-Za-z0-9_-]+/g, "-");
}
