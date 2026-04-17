import { describe, expect, it } from "bun:test";
import {
  PaneRegistry,
  ShellCore,
  createShellModel,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  normalizeBrowserUrl,
  type PaneSpec
} from "../src/shell";
import type { TerminalBackend, TerminalCreateInput } from "../src/terminal/backend";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../src/terminal/terminal";

const PROJECT_DIR = "/flmux-test";
const ORIGIN = "http://127.0.0.1:7000";

interface KillCall {
  rootKey: string;
  runtimeId: string;
}

interface RecordingBackend extends TerminalBackend {
  killCalls: KillCall[];
  createCalls: TerminalCreateInput[];
}

function recordingTerminalBackend(): RecordingBackend {
  const killCalls: KillCall[] = [];
  const createCalls: TerminalCreateInput[] = [];
  let nextRuntimeId = 0;

  return {
    killCalls,
    createCalls,
    adoptByPaneId: async () => ({ ok: true, outcome: "not_found" }),
    create: async (input) => {
      createCalls.push(input);
      const runtimeId = `rt_${++nextRuntimeId}`;
      const summary: TerminalRuntimeSummary = {
        rootKey: "root_test",
        runtimeId,
        ownerPaneId: input.paneId ?? null,
        cwd: input.cwd,
        alive: true,
        commandCount: 0,
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:00:00Z"
      };
      return { ok: true, rootKey: "root_test", runtimeId, history: "", terminal: summary };
    },
    write: async () => ({ ok: true, history: "", terminal: null }),
    resize: async () => ({ ok: true, terminal: null }),
    history: async () => ({ ok: true, history: "" }),
    kill: async (input) => {
      killCalls.push({ rootKey: input.rootKey, runtimeId: input.runtimeId });
      return { ok: true, killed: true };
    },
    listRoots: async () => [],
    subscribe: () => () => {}
  };
}

function buildShellCore(extraSpecs: PaneSpec[] = []) {
  const paneRegistry = new PaneRegistry<PaneSpec>();
  for (const spec of [...builtinSpecs(), ...extraSpecs]) {
    paneRegistry.register(spec);
  }
  const backend = recordingTerminalBackend();
  const core = new ShellCore({
    paneRegistry,
    runtimeLabel: "test",
    projectDir: PROJECT_DIR,
    terminalBackend: backend
  });
  core.setAppOrigin(ORIGIN);
  core.initialize();
  return { core, backend };
}

describe("ShellCore", () => {
  it("seeds the initial workspace with a browser pane anchored to the app origin", async () => {
    const { core } = buildShellCore();

    const workspace = await core.getWorkspaceStatus();
    expect(workspace).toMatchObject({ id: "workspace.1", title: "Workspace 1", paneCount: 1 });

    const panes = await core.listPanes();
    expect(panes).toHaveLength(1);
    const browser = panes[0]!;
    expect(browser.kind).toBe("browser");
    expect(browser.browser?.url.startsWith(ORIGIN)).toBe(true);
  });

  it("creates and closes panes and tracks paneWorkspaceIds via lookupPane", async () => {
    const { core } = buildShellCore();
    const created = await core.createPane({ kind: "browser", url: "/about" });
    expect(created.browser?.url).toBe(`${ORIGIN}/about`);

    const fetched = await core.getPane(created.id);
    expect(fetched?.id).toBe(created.id);

    const closeResult = await core.closePane(created.id);
    expect(closeResult).toEqual({ paneId: created.id, closed: true });

    expect(await core.getPaneParams(created.id)).toBeUndefined();
  });

  it("closePane kills the terminal runtime when the pane has one attached", async () => {
    const { core, backend } = buildShellCore();
    const pane = await core.createPane({ kind: "terminal", cwd: "." });
    const delegate = core.createTerminalDelegate();
    const attachResult = await delegate.attachRuntime(pane.id, { cwd: "." });
    expect(attachResult.ok).toBe(true);

    await core.closePane(pane.id);
    expect(backend.killCalls).toHaveLength(1);
    expect(backend.killCalls[0]).toEqual({ rootKey: "root_test", runtimeId: "rt_1" });
  });

  it("resetWorkspace kills every attached terminal runtime", async () => {
    const { core, backend } = buildShellCore();
    const delegate = core.createTerminalDelegate();
    const t1 = await core.createPane({ kind: "terminal", cwd: "." });
    const t2 = await core.createPane({ kind: "terminal", cwd: "." });
    await delegate.attachRuntime(t1.id, { cwd: "." });
    await delegate.attachRuntime(t2.id, { cwd: "." });

    const currentWorkspace = await core.getWorkspaceStatus();
    await core.resetWorkspace(currentWorkspace.id);

    expect(backend.killCalls.map((call) => call.runtimeId).sort()).toEqual(["rt_1", "rt_2"]);
  });

  it("rewrites browser pane urls when app origin changes", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/foo" });
    expect(pane.browser?.url).toBe(`${ORIGIN}/foo`);

    core.setAppOrigin("http://127.0.0.1:8100");
    const updated = await core.getPane(pane.id);
    expect(updated?.browser?.url).toBe("http://127.0.0.1:8100/foo");
  });

  it("normalizes browser url through setPaneParams against the current origin", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/initial" });

    const result = await core.setPaneParams(pane.id, { url: "/after" });
    expect(result.url).toBe(`${ORIGIN}/after`);

    const status = await core.getPane(pane.id);
    expect(status?.browser?.url).toBe(`${ORIGIN}/after`);
  });

  it("patchPaneParams merges a partial update onto the existing params", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/home" });

    await core.setPaneParams(pane.id, { url: "/home", extra: "keep" });
    const patched = await core.patchPaneParams(pane.id, { url: "/next" });
    expect(patched).toMatchObject({ url: `${ORIGIN}/next`, extra: "keep" });
  });

  it("applies terminal state events onto matching pane records", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "terminal", cwd: "." });

    const event: TerminalRuntimeEvent = {
      type: "state",
      paneId: pane.id,
      terminal: {
        rootKey: "root_abc",
        runtimeId: "rt_1",
        ownerPaneId: pane.id,
        cwd: "/new/cwd",
        alive: true,
        commandCount: 3,
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    };
    core.applyTerminalEvent(event);

    const status = await core.getPane(pane.id);
    expect(status?.terminal?.attached).toBe(true);
    expect(status?.terminal?.runtimeId).toBe("rt_1");
    expect(status?.terminal?.cwd).toBe("/new/cwd");
  });

  it("clears runtime state on terminal removed events but preserves cwd", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "terminal", cwd: "." });

    core.applyTerminalEvent({
      type: "state",
      paneId: pane.id,
      terminal: {
        rootKey: "root_abc",
        runtimeId: "rt_1",
        ownerPaneId: pane.id,
        cwd: "/cwd",
        alive: true,
        commandCount: 0,
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:00:00Z"
      }
    });
    core.applyTerminalEvent({
      type: "removed",
      paneId: pane.id,
      rootKey: "root_abc",
      runtimeId: "rt_1"
    });

    const status = await core.getPane(pane.id);
    expect(status?.terminal?.attached).toBe(false);
    expect(status?.terminal?.runtimeId).toBeNull();
    expect(status?.terminal?.cwd).toBe("/cwd");
  });

  it("routes scoped title changes (app/workspace/pane)", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/one" });

    await core.setScopedProperty({ scope: "app" }, "title", "MyApp");
    expect((await core.getAppStatus()).title).toBe("MyApp");

    await core.setScopedProperty({ scope: "workspace" }, "title", "HelloWorkspace");
    expect((await core.getWorkspaceStatus()).title).toBe("HelloWorkspace");

    await core.setScopedProperty({ scope: "pane", paneId: pane.id }, "title", "Custom");
    const status = await core.getPane(pane.id);
    expect(status?.title).toBe("Custom");
  });

  it("integrates with createShellModel for path-based workspace listing", async () => {
    const { core } = buildShellCore();
    const terminal = core.createTerminalDelegate();
    const shellModel = createShellModel({ host: core, terminal });

    const result = await shellModel.pathGet("/status/workspace");
    expect(result).toMatchObject({
      ok: true,
      found: true,
      value: { id: "workspace.1", paneCount: 1 }
    });
  });

  it("exposes extension-registered pane kinds via hasPaneKind and getPanePathMount", async () => {
    const { core } = buildShellCore([
      {
        kind: "sample-counter",
        pathMount: {
          mountKey: "counter",
          getStateSnapshot: () => ({ count: 42 })
        }
      }
    ]);

    expect(await core.hasPaneKind("sample-counter")).toBe(true);
    const pane = await core.createPane({ kind: "sample-counter" });
    const mount = await core.getPanePathMount(pane.id);
    expect(mount?.mountKey).toBe("counter");
    expect(await mount?.getStateSnapshot()).toEqual({ count: 42 });
  });

  it("creates separate workspaces whose bus is scoped to each id", async () => {
    const { core } = buildShellCore();
    const extra = await core.createWorkspace({ title: "Second" });
    expect(extra.id).toBe("workspace.2");

    const paneInSecond = await core.createPane({ kind: "browser", url: "/second" });
    const event = await core.publishWorkspaceEvent({
      topic: "test.topic",
      sourcePaneId: paneInSecond.id,
      payload: { hello: true }
    });
    expect(event.workspaceId).toBe("workspace.2");
  });
});

describe("normalizeBrowserUrl", () => {
  it("prepends the next origin for root-relative paths", () => {
    expect(normalizeBrowserUrl("", "http://o", "/a", "/d")).toBe("http://o/a");
  });

  it("rewrites from previous origin to the next one", () => {
    expect(normalizeBrowserUrl("http://old", "http://new", "http://old/x", "/d")).toBe("http://new/x");
  });

  it("preserves absolute urls on a third-party origin", () => {
    expect(normalizeBrowserUrl("", "http://o", "https://example.com/a", "/d")).toBe("https://example.com/a");
  });

  it("falls back to the default browser path on empty input", () => {
    expect(normalizeBrowserUrl("", "http://o", "   ", "/default")).toBe("http://o/default");
  });
});

function builtinSpecs(): PaneSpec[] {
  return [
    {
      kind: "browser",
      lifecycle: {
        createParams: ({ workspace, input }) => ({
          url: normalizeBrowserUrl("", "", input.url ?? workspace.defaultBrowserPath, workspace.defaultBrowserPath)
        }),
        getTitle: ({ input }) => input.title?.trim() || "Browser",
        createRecord: ({ workspace, params }) => ({
          kind: "browser",
          url: normalizeBrowserUrl(
            "",
            "",
            typeof params?.url === "string" ? params.url : workspace.defaultBrowserPath,
            workspace.defaultBrowserPath
          )
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isBrowserPaneStateRecord(record)
            ? { id: paneId, kind: "browser", title, active, browser: { url: record.url } }
            : { id: paneId, kind: record.kind, title, active }
      }
    },
    {
      kind: "terminal",
      lifecycle: {
        createParams: ({ input }) => ({ cwd: input.cwd ?? "." }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ params }) => ({
          kind: "terminal",
          cwd: typeof params?.cwd === "string" ? params.cwd : ".",
          rootKey: null,
          runtimeId: null,
          summary: null
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isTerminalPaneStateRecord(record)
            ? {
                id: paneId,
                kind: "terminal",
                title,
                active,
                terminal: {
                  attached: record.runtimeId !== null,
                  rootKey: record.rootKey,
                  cwd: record.cwd,
                  runtimeId: record.runtimeId,
                  alive: record.summary?.alive ?? null,
                  commandCount: record.summary?.commandCount ?? null,
                  createdAt: record.summary?.createdAt ?? null,
                  updatedAt: record.summary?.updatedAt ?? null
                }
              }
            : { id: paneId, kind: record.kind, title, active }
      }
    }
  ];
}
