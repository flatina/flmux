import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createSmokeHarness, type SmokeHarness } from "./smokeHarness";

interface ModelEnvelope<T> {
  ok: true;
  result: T;
}

describe("flmux harness smoke", () => {
  let harness: SmokeHarness;

  beforeAll(async () => {
    harness = await createSmokeHarness();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("lists registered clients over the external HTTP surface", async () => {
    const payload = await harness.fetchJson<{
      ok: true;
      clients: Array<{
        clientId: string;
        viewId: number;
        workspace: {
          id: string;
          title: string;
          paneCount: number;
        } | null;
      }>;
    }>("/api/clients");

    expect(payload.ok).toBe(true);
    expect(payload.clients).toHaveLength(1);
    expect(payload.clients[0]).toMatchObject({
      clientId: harness.clientId,
      workspace: {
        id: harness.workspaceId,
        title: "Workspace Smoke",
        paneCount: 0
      }
    });
  });

  it("keeps terminal happy path as a thin external canary", async () => {
    const newPane = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        value: {
          paneId: string;
          path: string;
          pane: {
            id: string;
            kind: string;
            title: string;
            active: boolean;
            terminal: {
              attached: boolean;
              cwd: string;
              runtimeId: string | null;
            };
          };
        };
      }>
    >(["call", "/panes/new", "kind=terminal", "cwd=.", "place=right"]);
    const paneId = newPane.result.value.paneId;
    expect(newPane.result.value).toMatchObject({
      path: `/panes/${paneId}`,
      pane: {
        id: paneId,
        kind: "terminal",
        terminal: {
          attached: false,
          runtimeId: null
        }
      }
    });

    const paneTerminal = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        found: true;
        value: {
          cwd: string;
        };
      }>
    >(["get", `/panes/${paneId}/terminal`]);
    expect(paneTerminal.result.value).toEqual({
      cwd: harness.workspaceRootDir
    });

    const createResult = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        value: {
          ok: true;
          rootKey: string;
          runtimeId: string;
          terminal: {
            runtimeId: string;
            cwd: string;
            rootDir: string;
            alive: boolean;
          };
        };
      }>
    >(["call", `/panes/${paneId}/terminal/attach`, "cwd=."]);
    const runtimeId = createResult.result.value.runtimeId;
    expect(createResult.result.value).toMatchObject({
      ok: true,
      runtimeId,
      terminal: {
        runtimeId,
        rootDir: harness.workspaceRootDir,
        alive: true
      }
    });

    const runtimeStatus = await harness.waitFor(
      async () => {
        const payload = await harness.runCliJson<
          ModelEnvelope<{
            ok: true;
            found: true;
            value: string | null;
          }>
        >(["get", `/status/panes/${paneId}/terminal/runtimeId`]);
        return payload.result.value ? payload.result : null;
      },
      { label: `runtimeId for ${paneId}` }
    );
    expect(runtimeStatus.value).toBe(runtimeId);

    const terminalStatus = await harness.runCliJson<
      ModelEnvelope<{
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
      }>
    >(["get", `/status/panes/${paneId}/terminal`]);
    expect(terminalStatus.result.value).toMatchObject({
      attached: true,
      rootKey: createResult.result.value.rootKey,
      cwd: harness.workspaceRootDir,
      runtimeId,
      alive: true
    });

    const resizeResult = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        value: {
          ok: true;
          accepted: boolean;
          runtimeId: string;
        };
      }>
    >(["call", `/panes/${paneId}/terminal/resize`, "cols=120", "rows=32"]);
    expect(resizeResult.result.value).toMatchObject({
      ok: true,
      accepted: true,
      runtimeId
    });

    const marker = `flmux-smoke-${crypto.randomUUID()}`;
    const writeResult = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        value: {
          ok: true;
          accepted: boolean;
          runtimeId: string;
        };
      }>
    >(["call", `/panes/${paneId}/terminal/write`, `data=echo ${marker}\r`]);
    expect(writeResult.result.value).toMatchObject({
      ok: true,
      accepted: true,
      runtimeId
    });

    const historyResult = await harness.waitFor(
      async () => {
        const payload = await harness.runCliJson<
          ModelEnvelope<{
            ok: true;
            value: {
              ok: true;
              runtimeId: string;
              data: string;
            };
          }>
        >(["call", `/panes/${paneId}/terminal/history`, "maxBytes=20000"]);
        return payload.result.value.data.includes(marker) ? payload.result.value : null;
      },
      { timeoutMs: 15_000, intervalMs: 250, label: `terminal history for ${paneId}` }
    );
    expect(historyResult).toMatchObject({
      ok: true,
      runtimeId
    });
    expect(historyResult.data).toContain(marker);

    const killResult = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        value: {
          ok: true;
          rootKey: string;
          runtimeId: string;
          killed: boolean;
        };
      }>
    >(["call", `/panes/${paneId}/terminal/kill`]);
    expect(killResult.result.value).toMatchObject({
      ok: true,
      runtimeId,
      killed: true
    });

    await harness.waitFor(
      async () => {
        const payload = await harness.runCliJson<
          ModelEnvelope<{
            ok: true;
            found: true;
            value: string | null;
          }>
        >(["get", `/status/panes/${paneId}/terminal/runtimeId`]);
        return payload.result.value === null ? true : null;
      },
      { label: `terminal kill propagation for ${paneId}` }
    );

    const detachedStatus = await harness.runCliJson<
      ModelEnvelope<{
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
      }>
    >(["get", `/status/panes/${paneId}/terminal`]);
    expect(detachedStatus.result.value).toEqual({
      attached: false,
      rootKey: null,
      cwd: harness.workspaceRootDir,
      runtimeId: null,
      alive: null,
      commandCount: null,
      createdAt: null,
      updatedAt: null
    });
  }, 30_000);

  it("dispatches a local extension CLI command through the real CLI entrypoint", async () => {
    const result = await harness.runCliJson<{
      ok: true;
      value: {
        paneId: string;
        path: string;
        pane: {
          id: string;
          kind: string;
          title: string;
          active: boolean;
        };
      };
    }>(["cowsay", "hello from cli"]);

    const paneId = result.value.paneId;
    expect(result.value).toMatchObject({
      path: `/panes/${paneId}`,
      pane: {
        id: paneId,
        kind: "cowsay",
        title: "hello from cli"
      }
    });

    const paneStatus = await harness.runCliJson<
      ModelEnvelope<{
        ok: true;
        found: true;
        value: {
          id: string;
          kind: string;
          title: string;
          active: boolean;
        };
      }>
    >(["get", `/status/panes/${paneId}`]);
    expect(paneStatus.result.value).toMatchObject({
      id: paneId,
      kind: "cowsay",
      title: "hello from cli"
    });
  });
});
