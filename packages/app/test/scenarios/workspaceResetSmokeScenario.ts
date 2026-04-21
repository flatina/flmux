import { expect } from "bun:test";
import { callJsonRpcIpc } from "@flmux/core/terminal/ptyd/jsonRpcIpc";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import { loadPtydLockForRootDir } from "../support/ptydCleanup";
import {
  allocateFlmuxRootDir,
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
  const rootDir = allocateFlmuxRootDir("session");
  const app = launchFlmuxApp(port, rootDir);
  appHandles.push(app);

  try {
    const mainTarget = await waitForMainTarget(port, "reset smoke main target");
    const appOrigin = new URL(mainTarget.url).origin;
    const secondWorkspaceId = "workspace.2";
    const secondWorkspaceStartUrl = `${appOrigin}/__flmux/internal/start?workspace=${secondWorkspaceId}`;

    const session = await connectCdp(mainTarget.webSocketDebuggerUrl!);
    await session.send("Runtime.enable");
    const clientId = await waitForSingleClientId(appOrigin, "reset smoke client id");

    const created = await postJson<{
      ok: true;
      result: { ok: true; value: { workspaceId: string } };
    }>(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: "/workspaces/new"
    });
    expect(created.result.value.workspaceId).toBe(secondWorkspaceId);

    await waitFor(
      async () => {
        const title = await session.evaluate<string>(`document.title`);
        return title.includes("Workspace 2") ? title : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 active before reset" }
    );

    await waitFor(
      async () => {
        const targets = await fetchTargets(port);
        return targets.some((target) => target.url === secondWorkspaceStartUrl) ? true : null;
      },
      { timeoutMs: 20_000, intervalMs: 500, label: "workspace 2 start target before reset" }
    );

    const retitled = await postJson<{
      ok: true;
      result: { ok: true; value: string };
    }>(`${appOrigin}/api/model/path/set`, {
      clientId,
      path: `/workspaces/${secondWorkspaceId}/title`,
      value: "Workspace 2 Renamed"
    });
    expect(retitled.result.value).toBe("Workspace 2 Renamed");

    const terminalPane = await postJson<{
      ok: true;
      result: { ok: true; value: { paneId: string } };
    }>(`${appOrigin}/api/model/path/call`, {
      clientId,
      path: "/panes/new",
      args: { kind: "terminal", cwd: ".", place: "right" }
    });
    const terminalPaneId = terminalPane.result.value.paneId;

    const attached = await waitFor(
      async () => {
        const status = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: { attached: boolean; rootKey: string | null; runtimeId: string | null };
          };
        }>(`${appOrigin}/api/model/path/get`, {
          clientId,
          path: `/status/panes/${terminalPaneId}/terminal`
        });
        return status.result.value.attached && status.result.value.runtimeId
          ? { runtimeId: status.result.value.runtimeId }
          : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal auto-attach before reset" }
    );
    const runtimeId = attached.runtimeId;
    expect(runtimeId).toBeTruthy();

    const resetClicked = await session.evaluate<boolean>(`(() => {
      const button = document.querySelector('.header-action__btn[title="Reset Active Workspace"]');
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    })()`);
    expect(resetClicked).toBe(true);

    const workspaceStatus = await waitFor(
      async () => {
        const status = await postJson<{
          ok: true;
          result: {
            ok: true;
            found: true;
            value: {
              id: string;
              title: string;
              defaultTitle: string;
              paneCount: number;
            };
          };
        }>(`${appOrigin}/api/model/path/get`, {
          clientId,
          path: `/status/workspaces/${secondWorkspaceId}`
        });
        return status.result.value.id === secondWorkspaceId &&
          status.result.value.title === "Workspace 2" &&
          status.result.value.paneCount === 2
          ? status.result.value
          : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 reset to default" }
    );
    expect(workspaceStatus.paneCount).toBe(2);

    const removedTerminal = await postJson<{
      ok: true;
      result: { ok: true; found: boolean; value: unknown };
    }>(`${appOrigin}/api/model/path/get`, {
      clientId,
      path: `/status/panes/${terminalPaneId}`
    });
    expect(removedTerminal.result).toEqual({
      ok: true,
      found: false,
      value: null
    });

    await waitFor(
      async () => {
        const title = await session.evaluate<string>(`document.title`);
        return title.includes("Workspace 2") && !title.includes("Renamed") ? title : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "workspace title reset" }
    );

    // Reset must leave no runtime owned by the workspace.2 terminal pane we
    // just killed. Filter by ownerPaneId rather than checking total runtime
    // count so sibling workspace terminals (if any) don't mask a leak.
    await waitFor(
      async () => {
        const lock = await loadPtydLockForRootDir(rootDir);
        if (!lock) {
          return true;
        }

        let listing: { terminals: Array<{ ownerPaneId: string | null }> } | null;
        try {
          listing = await callJsonRpcIpc<{ terminals: Array<{ ownerPaneId: string | null }> }>(
            lock.controlIpcPath,
            "terminal.list",
            undefined,
            2_000
          );
        } catch {
          listing = null;
        }

        return listing === null || listing.terminals.every((terminal) => terminal.ownerPaneId !== terminalPaneId)
          ? true
          : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "workspace 2 terminal runtime cleared from install-scoped daemon" }
    );

    await session.close();
  } finally {
    // rootDir teardown happens in cleanupAppHandles (afterEach).
  }
}
