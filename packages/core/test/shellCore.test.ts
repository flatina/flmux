import { describe, expect, it } from "bun:test";
import {
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  normalizeBrowserUrl,
  type PaneSpec
} from "../src/shell";
import type { TerminalBackend, TerminalCreateInput } from "../src/terminal/backend";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../src/terminal/types";

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
  paneRegistry.register(createPlaceholderPaneSpec());
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
  it("creates the initial workspace empty — pane seeding is the workbench's responsibility", async () => {
    const { core } = buildShellCore();

    const workspace = await core.getWorkspaceStatus();
    expect(workspace).toMatchObject({ id: "workspace.1", title: "Workspace 1", paneCount: 0 });
    expect(await core.listPanes()).toEqual([]);
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

  it("singletonScope=workspace activates the existing pane instead of creating a duplicate", async () => {
    const singletonSpec: PaneSpec = {
      kind: "myext.tag-tree",
      singletonScope: "workspace",
      lifecycle: {
        createRecord: () => ({ kind: "myext.tag-tree" }),
        createSnapshot: ({ paneId, title }) => ({ id: paneId, kind: "myext.tag-tree", title }),
        getTitle: () => "Tag Tree"
      }
    };
    const { core } = buildShellCore([singletonSpec]);

    const events: Array<{ topic: string; paneId?: string }> = [];
    core.subscribe((event) => {
      if (event.topic === "pane.added" || event.topic === "pane.activeChanged") {
        events.push({ topic: event.topic, paneId: (event.payload as { paneId?: string }).paneId });
      }
    });

    const first = await core.createPane({ kind: "myext.tag-tree" });
    const second = await core.createPane({ kind: "myext.tag-tree" });

    expect(second.id).toBe(first.id);
    expect((await core.listPanes()).map((p) => p.id)).toEqual([first.id]);
    expect(events.filter((e) => e.topic === "pane.added")).toHaveLength(1);
  });

  it("singletonScope=app — same workspace activates; cross-workspace returns snapshot without switching", async () => {
    const appSingletonSpec: PaneSpec = {
      kind: "myext.agent",
      singletonScope: "app",
      lifecycle: {
        createRecord: () => ({ kind: "myext.agent" }),
        createSnapshot: ({ paneId, title }) => ({ id: paneId, kind: "myext.agent", title }),
        getTitle: () => "Agent"
      }
    };
    const { core } = buildShellCore([appSingletonSpec]);

    const ws1 = (await core.getWorkspaceStatus()).id;
    const ws2 = (await core.createWorkspace()).id;

    // Create the singleton in ws1.
    const created = await core.createPane({ kind: "myext.agent" }, { workspaceId: ws1 });

    // Switch caller's active workspace to ws2 and try again — must NOT
    // switch active workspace, must NOT create a duplicate.
    core.setActiveWorkspace(ws2);
    const before = core.getSlotActiveWorkspaceId();
    const reused = await core.createPane({ kind: "myext.agent" }, { workspaceId: ws2 });
    const after = core.getSlotActiveWorkspaceId();

    expect(reused.id).toBe(created.id);
    expect(after).toBe(before);
    expect((await Promise.resolve(core.listPanesByWorkspace(ws1))).map((p) => p.id)).toEqual([created.id]);
    expect(await Promise.resolve(core.listPanesByWorkspace(ws2))).toEqual([]);

    // Calling from ws1 (where it lives) is a no-op for state — still single.
    core.setActiveWorkspace(ws1);
    await core.createPane({ kind: "myext.agent" }, { workspaceId: ws1 });
    expect((await Promise.resolve(core.listPanesByWorkspace(ws1))).map((p) => p.id)).toEqual([created.id]);
  });

  it("setAppOrigin stores the origin without rewriting existing panes (adapter owns re-normalization)", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/foo" });
    expect(pane.browser?.url).toBe(`${ORIGIN}/foo`);

    core.setAppOrigin("http://127.0.0.1:8100");
    const updated = await core.getPane(pane.id);
    expect(updated?.browser?.url).toBe(`${ORIGIN}/foo`);
    expect((await core.getAppStatus()).origin).toBe("http://127.0.0.1:8100");
  });

  it("setPaneParams stores params verbatim; URL normalization flows through the /browser/url subtree", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/initial" });

    const raw = await core.setPaneParams(pane.id, { url: "/after" });
    expect(raw.url).toBe("/after");
  });

  it("patchPaneParams merges a partial update onto the existing params verbatim", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/home" });

    await core.setPaneParams(pane.id, { url: "/home", extra: "keep" });
    const patched = await core.patchPaneParams(pane.id, { url: "/next" });
    expect(patched).toMatchObject({ url: "/next", extra: "keep" });
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

    const result = await shellModel.pathGet("/status/workspaces/workspace.1");
    expect(result).toMatchObject({
      ok: true,
      found: true,
      value: { id: "workspace.1", paneCount: 0 }
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

  it("restoreWorkspace creates an empty workspace without seeding default panes", async () => {
    const { core } = buildShellCore();
    const status = core.restoreWorkspace({ id: "workspace.99", title: "Restored" });
    expect(status).toMatchObject({ id: "workspace.99", title: "Restored", paneCount: 0 });
    expect(core.getWorkspaceIds()).toContain("workspace.99");
  });

  it("restorePane reuses the given paneId and rebuilds state from persisted params", async () => {
    const { core } = buildShellCore();
    core.restoreWorkspace({ id: "workspace.99", title: "Restored", setActive: true });
    const snapshot = core.restorePane("workspace.99", {
      paneId: "pane_original",
      kind: "browser",
      params: { url: "/saved" },
      title: "Saved Browser"
    });
    expect(snapshot.id).toBe("pane_original");
    expect(snapshot.browser?.url).toBe(`${ORIGIN}/saved`);
    expect(snapshot.title).toBe("Saved Browser");

    const fetched = await core.getPane("pane_original");
    expect(fetched?.browser?.url).toBe(`${ORIGIN}/saved`);
  });

  it("setActiveWorkspace + setActivePane change cursor without touching other state", async () => {
    const { core } = buildShellCore();
    const extra = await core.createWorkspace({ title: "Second" });
    core.setActiveWorkspace("workspace.1");
    expect(core.getSlotActiveWorkspaceId()).toBe("workspace.1");

    core.setActiveWorkspace(extra.id);
    expect(core.getSlotActiveWorkspaceId()).toBe(extra.id);

    const pane = await core.createPane({ kind: "browser", url: "/x" });
    core.clearActivePane(extra.id);
    expect(core.getSlotActivePaneId(extra.id)).toBeNull();
    core.setActivePane(pane.id);
    expect(core.getSlotActivePaneId(extra.id)).toBe(pane.id);
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

  it("exposes a workspace context with id/defaultBrowserPath/bus/appOrigin", async () => {
    const { core } = buildShellCore();
    const context = core.getWorkspaceContext("workspace.1");
    expect(context).toBeDefined();
    expect(context?.id).toBe("workspace.1");
    expect(context?.appOrigin).toBe(ORIGIN);
    expect(context?.defaultBrowserPath).toContain("workspace.1");
    expect(typeof context?.bus.publish).toBe("function");
    expect(core.getWorkspaceContext("workspace.missing")).toBeUndefined();
  });

  it("resolves paneId → workspaceId via getPaneWorkspaceId", async () => {
    const { core } = buildShellCore();
    const extra = await core.createWorkspace({ title: "Second" });
    const paneInSecond = await core.createPane({ kind: "browser", url: "/x" });
    expect(core.getPaneWorkspaceId(paneInSecond.id)).toBe(extra.id);
    expect(core.getPaneWorkspaceId("pane_missing")).toBeUndefined();
  });

  it("substitutes placeholder when restorePane sees an unknown kind", async () => {
    const { core } = buildShellCore();
    const snapshot = core.restorePane("workspace.1", {
      paneId: "pane_ghost",
      kind: "unknown-kind",
      params: { seed: 42 },
      title: "Ghost"
    });
    expect(snapshot.id).toBe("pane_ghost");
    expect(snapshot.kind).toBe("placeholder");
    expect(snapshot.title).toBe("Missing: unknown-kind");

    const params = await core.getPaneParams("pane_ghost");
    expect(params).toEqual({ originalKind: "unknown-kind", error: expect.stringContaining("unknown-kind") });
  });

  it("deleteWorkspace drops pane records, paneWorkspaceIds, and kills attached terminals", async () => {
    const { core, backend } = buildShellCore();
    const second = await core.createWorkspace({ title: "Second" });
    const termPane = await core.createPane({ kind: "terminal", cwd: "." });
    const delegate = core.createTerminalDelegate();
    await delegate.attachRuntime(termPane.id, { cwd: "." });
    const browserPane = await core.createPane({ kind: "browser", url: "/x" });

    await core.deleteWorkspace(second.id);

    expect(backend.killCalls).toEqual([{ rootKey: "root_test", runtimeId: "rt_1" }]);
    expect(core.getWorkspaceIds()).toEqual(["workspace.1"]);
    expect(core.getPaneWorkspaceId(termPane.id)).toBeUndefined();
    expect(core.getPaneWorkspaceId(browserPane.id)).toBeUndefined();
    expect(await core.closePane(termPane.id)).toEqual({ paneId: termPane.id, closed: false });
    expect(core.getSlotActiveWorkspaceId()).toBe("workspace.1");
  });

  it("deleteWorkspace on an unknown id is a no-op", async () => {
    const { core } = buildShellCore();
    await core.deleteWorkspace("workspace.ghost");
    expect(core.getWorkspaceIds()).toEqual(["workspace.1"]);
  });

  it("deleting the last workspace auto-reseeds a default workspace", async () => {
    const { core } = buildShellCore();
    expect(core.getWorkspaceIds()).toEqual(["workspace.1"]);

    await core.deleteWorkspace("workspace.1");

    const ids = core.getWorkspaceIds();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("workspace.1");
    expect(core.getSlotActiveWorkspaceId()).toBe("workspace.1");
  });

  it("last-workspace delete reseed bumps every affected slot, not only the default", async () => {
    const { core } = buildShellCore();
    // Put two slots on workspace.1: default (from initialize) + a second slot.
    core.setActiveWorkspace("workspace.1", { slotKey: "other" });
    expect(core.getSlotActiveWorkspaceId("other")).toBe("workspace.1");

    const captured: Array<{ topic: string; target?: string; payload: any }> = [];
    core.subscribe((event) =>
      captured.push({ topic: event.topic, target: event.targetAttachmentId, payload: event.payload })
    );

    await core.deleteWorkspace("workspace.1");

    // Both slots land on the reseed, not null.
    expect(core.getSlotActiveWorkspaceId()).toBe("workspace.1");
    expect(core.getSlotActiveWorkspaceId("other")).toBe("workspace.1");

    const activeChanges = captured.filter((e) => e.topic === "workspace.activeChanged");
    // Sequence:
    // 1. intermediate null emitted per affected slot (before reseed)
    // 2. reseed workspace.added
    // 3. default slot to ws.1 (inside initialize)
    // 4. other slot to ws.1 (deleteWorkspace walks affected slots)
    const perSlot = activeChanges.reduce<Record<string, string[]>>((acc, e) => {
      const key = e.target ?? "__default__";
      (acc[key] ??= []).push((e.payload as { id: string | null }).id ?? "null");
      return acc;
    }, {});
    // Order inside each slot: null → "workspace.1".
    expect(perSlot[core.defaultSlotKey]).toEqual(["null", "workspace.1"]);
    expect(perSlot.other).toEqual(["null", "workspace.1"]);

    // workspace.removed precedes the intermediate null activeChanged; reseed's
    // workspace.added precedes the "workspace.1" activeChanged events.
    const order = captured.map((e) => e.topic);
    expect(order.indexOf("workspace.removed")).toBeLessThan(order.indexOf("workspace.activeChanged"));
    expect(order.indexOf("workspace.added")).toBeLessThan(order.lastIndexOf("workspace.activeChanged"));
  });

  it("listPanesByWorkspace is workspace-scoped and safe for inactive workspaces", async () => {
    const { core } = buildShellCore();
    // Workspaces are created empty; populate each one explicitly so the
    // scoping assertion has something to compare.
    const firstPane = await core.createPane({ kind: "browser", url: "/first" });
    const second = await core.createWorkspace({ title: "Second" });
    const secondPane = await core.createPane({ kind: "browser", url: "/extra" });
    core.setActiveWorkspace("workspace.1");

    const firstPanes = core.listPanesByWorkspace("workspace.1");
    const secondPanes = core.listPanesByWorkspace(second.id);

    expect(firstPanes.map((pane) => pane.id)).toEqual([firstPane.id]);
    expect(secondPanes.map((pane) => pane.id)).toEqual([secondPane.id]);
  });

  it("setActiveWorkspace noops on unknown id (no throw)", async () => {
    const { core } = buildShellCore();
    // initialize() seeded default slot's active to workspace.1; setting an
    // unknown id resets it to null per the "next && workspaces.has(next)"
    // resolution rule.
    core.setActiveWorkspace("workspace.ghost");
    expect(core.getSlotActiveWorkspaceId()).toBeNull();
    core.setActiveWorkspace("workspace.1");
    expect(core.getSlotActiveWorkspaceId()).toBe("workspace.1");
  });

  it("serializePaneParams runs the pane spec's persistence hook", async () => {
    const loudSpec: PaneSpec = {
      kind: "loud",
      persistence: {
        serializeParams: ({ currentParams }) => ({
          note: String(currentParams?.note ?? "").toUpperCase()
        })
      }
    };
    const { core } = buildShellCore([loudSpec]);
    const pane = await core.createPane({ kind: "loud", params: { note: "hello" } });
    expect(core.serializePaneParams(pane.id)).toEqual({ note: "HELLO" });
  });

  it("peekPaneParams returns a clone of the stored params (sync)", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "browser", url: "/pristine" });
    const params = core.peekPaneParams(pane.id);
    expect(params).toEqual({ url: `${ORIGIN}/pristine` });
    params!.url = "mutated";
    expect(core.peekPaneParams(pane.id)).toEqual({ url: `${ORIGIN}/pristine` });
  });

  it("getWorkspaceSnapshot returns defaultTitle for saves", async () => {
    const { core } = buildShellCore();
    await core.setScopedProperty({ scope: "workspace" }, "title", "Custom Label");
    const snapshot = core.getWorkspaceSnapshot("workspace.1");
    expect(snapshot).toMatchObject({
      id: "workspace.1",
      title: "Custom Label",
      defaultTitle: "Workspace 1"
    });
  });

  it("emitter subscribes, fires on mutation, and unsubscribes", async () => {
    const { core } = buildShellCore();
    const events: Array<{ seq: number; topic: string }> = [];
    const unsubscribe = core.subscribe((event) => {
      events.push({ seq: event.seq, topic: event.topic });
    });

    await core.setScopedProperty({ scope: "app" }, "title", "flmux-test");
    expect(events.map((e) => e.topic)).toEqual(["app.titleChanged"]);
    expect(events[0]!.seq).toBeGreaterThan(0);

    unsubscribe();
    await core.setScopedProperty({ scope: "app" }, "title", "flmux-ignored");
    expect(events).toHaveLength(1);
  });

  it("emitter seq numbers are monotonic", async () => {
    const { core } = buildShellCore();
    // Workspaces are empty at start — add a pane so closePane has a target.
    const pane = await core.createPane({ kind: "browser", url: "/x" });
    const seqs: number[] = [];
    core.subscribe((event) => {
      seqs.push(event.seq);
    });
    await core.createWorkspace({ title: "Second" });
    await core.closePane(pane.id);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("emit suppresses no-op mutations (same value)", async () => {
    const { core } = buildShellCore();
    const events: string[] = [];
    core.subscribe((event) => events.push(event.topic));

    await core.setScopedProperty({ scope: "app" }, "title", "flmux-once");
    await core.setScopedProperty({ scope: "app" }, "title", "flmux-once");
    expect(events.filter((t) => t === "app.titleChanged")).toHaveLength(1);

    core.setActiveWorkspace("workspace.1");
    expect(events.filter((t) => t === "workspace.activeChanged")).toHaveLength(0);
  });

  it("broadcast topics carry scope='all' and no targetAttachmentId", async () => {
    const { core } = buildShellCore();
    const captured: Array<{ topic: string; scope: string; targetAttachmentId?: string }> = [];
    core.subscribe((event) =>
      captured.push({ topic: event.topic, scope: event.scope, targetAttachmentId: event.targetAttachmentId })
    );

    await core.createWorkspace({ title: "Second" });
    const wsAdded = captured.find((e) => e.topic === "workspace.added")!;
    expect(wsAdded.scope).toBe("all");
    expect(wsAdded.targetAttachmentId).toBeUndefined();

    const pane = await core.createPane({ kind: "browser", url: "/x" });
    const paneAdded = captured.find((e) => e.topic === "pane.added")!;
    expect(paneAdded.scope).toBe("all");
    expect(paneAdded.targetAttachmentId).toBeUndefined();

    await core.setScopedProperty({ scope: "app" }, "title", "flmux-test-scope");
    const titleChanged = captured.find((e) => e.topic === "app.titleChanged")!;
    expect(titleChanged.scope).toBe("all");
    expect(titleChanged.targetAttachmentId).toBeUndefined();
    expect(pane.id).toBeTruthy();
  });

  it("setActiveWorkspace with explicit slotKey routes event to that target", async () => {
    const { core } = buildShellCore();
    await core.createWorkspace({ title: "Second" });
    const captured: Array<{ topic: string; scope: string; targetAttachmentId?: string; payload: any }> = [];
    core.subscribe((event) =>
      captured.push({
        topic: event.topic,
        scope: event.scope,
        targetAttachmentId: event.targetAttachmentId,
        payload: event.payload
      })
    );

    core.setActiveWorkspace("workspace.1", { slotKey: "other.attachment" });
    const activeChanged = captured.find((e) => e.topic === "workspace.activeChanged")!;
    expect(activeChanged.scope).toBe("attachment");
    expect(activeChanged.targetAttachmentId).toBe("other.attachment");
    expect(activeChanged.payload).toEqual({ id: "workspace.1" });

    // Default slot's active is unchanged by a targeted mutation.
    expect(core.getSlotActiveWorkspaceId("other.attachment")).toBe("workspace.1");
    expect(core.getSlotActiveWorkspaceId()).not.toBe("workspace.1");
  });

  it("two slots maintain independent active workspace + pane state", async () => {
    const { core } = buildShellCore();
    // Seed ws.1 with a pane so slot B has something to activate.
    core.setActiveWorkspace("workspace.1");
    const paneOnWs1 = await core.createPane({ kind: "browser", url: "/ws1" });
    const extra = await core.createWorkspace({ title: "Second" });
    const paneInExtra = await core.createPane({ kind: "browser", url: "/x" });

    // Default slot is on `extra` (createWorkspace bumped it). Put slot "B" on ws.1.
    core.setActiveWorkspace("workspace.1", { slotKey: "B" });
    core.setActivePane(paneOnWs1.id, { slotKey: "B" });

    expect(core.getSlotActiveWorkspaceId()).toBe(extra.id);
    expect(core.getSlotActiveWorkspaceId("B")).toBe("workspace.1");
    expect(core.getSlotActivePaneId(extra.id)).toBe(paneInExtra.id);
    expect(core.getSlotActivePaneId("workspace.1", "B")).toBe(paneOnWs1.id);
    // Slot B has no opinion on `extra`.
    expect(core.getSlotActivePaneId(extra.id, "B")).toBeNull();
  });

  it("createPane without a workspace target throws ModelPathError INVALID_VALUE", async () => {
    const { core } = buildShellCore();
    // Drop default slot's active workspace so the implicit fallback fails.
    core.setActiveWorkspace(null);

    await expect(core.createPane({ kind: "browser", url: "/x" })).rejects.toMatchObject({
      code: "INVALID_VALUE"
    });

    // Slot-only option (no args.workspaceId, slot has no active) also fails.
    await expect(core.createPane({ kind: "browser" }, { slotKey: "never.bootstrapped" })).rejects.toMatchObject({
      code: "INVALID_VALUE"
    });
  });

  it("closing active pane emits pane.removed + scope=attachment pane.activeChanged", async () => {
    const { core } = buildShellCore();
    // Workspaces start empty — seed two panes so closing the active one has
    // a sibling to fall back onto.
    const first = await core.createPane({ kind: "browser", url: "/f" });
    const second = await core.createPane({ kind: "browser", url: "/s" });

    const captured: Array<{ topic: string; scope: string; targetAttachmentId?: string; payload: any }> = [];
    core.subscribe((event) =>
      captured.push({
        topic: event.topic,
        scope: event.scope,
        targetAttachmentId: event.targetAttachmentId,
        payload: event.payload
      })
    );

    await core.closePane(second.id);
    const removed = captured.find((e) => e.topic === "pane.removed")!;
    expect(removed.payload).toEqual({ paneId: second.id, workspaceId: "workspace.1" });
    expect(removed.scope).toBe("all");

    const activeChanged = captured.find((e) => e.topic === "pane.activeChanged")!;
    expect(activeChanged.payload).toEqual({ workspaceId: "workspace.1", paneId: first.id });
    expect(activeChanged.scope).toBe("attachment");
    expect(activeChanged.targetAttachmentId).toBeTruthy();
  });

  it("terminal.applyTerminalEvent does not emit shellCore.event topics", async () => {
    const { core } = buildShellCore();
    const pane = await core.createPane({ kind: "terminal", cwd: "." });
    const delegate = core.createTerminalDelegate();
    await delegate.attachRuntime(pane.id, { cwd: "." });

    const events: string[] = [];
    core.subscribe((event) => events.push(event.topic));

    core.applyTerminalEvent({
      type: "state",
      paneId: pane.id,
      terminal: {
        rootKey: "root_test",
        runtimeId: "rt_1",
        ownerPaneId: pane.id,
        cwd: "/other",
        alive: true,
        commandCount: 1,
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:00:00Z"
      }
    });
    core.applyTerminalEvent({ type: "output", paneId: pane.id, data: "hello" });
    core.applyTerminalEvent({ type: "removed", paneId: pane.id });

    expect(events).toEqual([]);
  });

  it("substitutes placeholder when a pane spec's lifecycle/persistence hook throws", async () => {
    const hostileSpec: PaneSpec = {
      kind: "hostile",
      persistence: {
        normalizeRestoredParams: () => {
          throw new Error("boom");
        }
      }
    };
    const { core } = buildShellCore([hostileSpec]);

    const snapshot = core.restorePane("workspace.1", {
      paneId: "pane_hostile",
      kind: "hostile",
      params: { seed: 42 }
    });
    expect(snapshot.kind).toBe("placeholder");
    const params = await core.getPaneParams("pane_hostile");
    expect(params).toEqual({ originalKind: "hostile", error: "boom" });
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
          url: normalizeBrowserUrl(
            "",
            workspace.appOrigin,
            input.url ?? workspace.defaultBrowserPath,
            workspace.defaultBrowserPath
          )
        }),
        getTitle: ({ input }) => input.title?.trim() || "Browser",
        createRecord: ({ workspace, params }) => ({
          kind: "browser",
          url: normalizeBrowserUrl(
            "",
            workspace.appOrigin,
            typeof params?.url === "string" ? params.url : workspace.defaultBrowserPath,
            workspace.defaultBrowserPath
          )
        }),
        createSnapshot: ({ paneId, title, record }) =>
          isBrowserPaneStateRecord(record)
            ? { id: paneId, kind: "browser", title, browser: { url: record.url } }
            : { id: paneId, kind: record.kind, title }
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
        createSnapshot: ({ paneId, title, record }) =>
          isTerminalPaneStateRecord(record)
            ? {
                id: paneId,
                kind: "terminal",
                title,
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
            : { id: paneId, kind: record.kind, title }
      }
    }
  ];
}
