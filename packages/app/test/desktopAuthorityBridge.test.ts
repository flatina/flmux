import { describe, expect, it } from "bun:test";
import { pack } from "msgpackr";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { createDesktopShellAuthority } from "../src/main/desktopShellAuthority";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { createFlmuxHostRequestHandlers } from "../src/main/hostRequests";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import type { FlmuxSessionStore } from "../src/main/sessionStore";
import type { FlmuxSessionSnapshot } from "../src/shared/session";
import type { FlmuxSessionSaveLayouts, FlmuxRendererBridge } from "../src/shared/rendererBridge";

function createMemorySessionStore(initial: FlmuxSessionSnapshot | null = null): FlmuxSessionStore & {
  current(): FlmuxSessionSnapshot | null;
} {
  let current = initial;
  return {
    async load() {
      return current;
    },
    async save(snapshot) {
      current = snapshot;
    },
    current: () => current
  };
}

async function createTestAuthority(options: { initial?: FlmuxSessionSnapshot | null } = {}) {
  const terminalService = createTerminalService(createInMemoryTerminalBackend());
  const clientRegistry = new FlmuxClientRegistry();
  const sessionStore = createMemorySessionStore(options.initial ?? null);
  const authority = await createDesktopShellAuthority({
    projectDir: "C:/project",
    runtimeLabel: "desktop-test",
    terminalService,
    sessionStore,
    clientRegistry
  });
  await authority.start("http://127.0.0.1:0");
  return { authority, sessionStore, clientRegistry, terminalService };
}

describe("desktop shell authority bridge", () => {
  it("seeds a default workspace when no session snapshot exists", async () => {
    const { authority } = await createTestAuthority();
    const bootstrap = authority.shellBootstrap();

    expect(bootstrap.snapshot.workspaces).toHaveLength(1);
    expect(bootstrap.snapshot.workspaces[0].id).toBe("workspace.1");
    expect(bootstrap.snapshot.panes["workspace.1"]).toBeDefined();
    expect(bootstrap.outerLayout).toBeNull();
    expect(bootstrap.innerLayouts).toEqual({});
    expect(bootstrap.seqStart).toBeGreaterThanOrEqual(0);
  });

  it("emits granular shellCore events on mutations", async () => {
    const { authority } = await createTestAuthority();
    const received: SequencedShellCoreEvent[] = [];
    authority.subscribe((event) => received.push(event));

    await authority.shellModel.pathCall("/workspaces/new");
    const topics = received.map((event) => event.topic);
    expect(topics).toContain("workspace.added");
    expect(topics).toContain("workspace.activeChanged");

    const seqs = received.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("registerClient returns only {clientId} over the wire (no Proxy leakage)", async () => {
    const { authority, clientRegistry } = await createTestAuthority();
    const viewId = 77;
    clientRegistry.attachRenderer(viewId, {
      sendProxy: {
        "terminal.event": () => {},
        "shellCore.event": () => {}
      }
    });
    const registration = authority.router.registerClient(viewId);
    expect(Object.keys(registration).sort()).toEqual(["clientId"]);
    expect(typeof registration.clientId).toBe("string");
  });

  // Pins the bug-class, not just this RPC's shape: the real `FlmuxRendererBridge`
  // on the preload wire is a Proxy whose get resolves every key to a function,
  // and msgpackr's pack() probes `value.toJSON` during encoding. Returning that
  // Proxy in a response invokes toJSON as a nested RPC, whose unhandled
  // rejection crashes Bun. Any RPC that returns a Proxy-backed object has the
  // same failure — so assert at encoder level.
  it("registerClient response packs without probing the bridge Proxy", async () => {
    const { authority, clientRegistry } = await createTestAuthority();
    const viewId = 78;
    let bridgeProbed = false;
    const bridge = new Proxy({} as FlmuxRendererBridge, {
      get: (_target, key) => {
        if (typeof key === "string") {
          bridgeProbed = true;
        }
        return () => {};
      }
    });
    clientRegistry.attachRenderer(viewId, bridge);

    const registration = authority.router.registerClient(viewId);
    bridgeProbed = false;
    pack(registration);
    expect(bridgeProbed).toBe(false);

    // Sanity: if a future RPC hands the full record through, pack *does* probe
    // the bridge — this half fails loudly if the mechanism ever stops
    // reproducing (e.g. msgpackr stops calling toJSON), prompting a revisit.
    bridgeProbed = false;
    pack({ clientId: registration.clientId, viewId, bridge });
    expect(bridgeProbed).toBe(true);
  });

  it("shellBootstrap returns synchronously (not a Promise) — preflight #1 §S3", async () => {
    const { authority } = await createTestAuthority();
    const result = authority.shellBootstrap();
    expect(result).not.toHaveProperty("then");
    expect(typeof result.seqStart).toBe("number");
  });

  it("shellBootstrap captures seqStart before composing snapshot", async () => {
    const { authority } = await createTestAuthority();
    const first = authority.shellBootstrap();
    await authority.shellModel.pathCall("/workspaces/new");
    const second = authority.shellBootstrap();
    expect(second.seqStart).toBeGreaterThan(first.seqStart);
  });

  it("persistSession composes snapshot from core state + renderer layouts", async () => {
    const { authority, sessionStore } = await createTestAuthority();
    const outerLayout = {
      panels: {
        "workspace.1": {
          id: "workspace.1",
          contentComponent: "workspace",
          title: "Workspace 1"
        }
      }
    };
    const innerLayouts: Record<string, unknown> = {
      "workspace.1": {
        panels: {
          "pane.x": {
            id: "pane.x",
            contentComponent: "cowsay",
            title: "Cowsay"
          }
        }
      }
    };
    const layouts: FlmuxSessionSaveLayouts = { outerLayout, innerLayouts };

    await authority.persistSession(layouts);
    const stored = sessionStore.current();
    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(4);
    expect(stored!.outerLayout).toEqual(outerLayout);
    expect(stored!.workspaces["workspace.1"]).toBeDefined();
    expect(stored!.workspaces["workspace.1"].title).toBe("Workspace 1");
  });

  it("persistSession drops workspaces not in outerLayout (self-consistent save)", async () => {
    const { authority, sessionStore } = await createTestAuthority();
    // Create a second workspace in core
    const result = await authority.shellModel.pathCall("/workspaces/new") as { value: { workspaceId: string } };
    const orphanWorkspaceId = result.value.workspaceId;

    // Layouts only mention workspace.1 — orphan should be filtered out of saved workspaces
    await authority.persistSession({
      outerLayout: { panels: { "workspace.1": { id: "workspace.1", contentComponent: "workspace" } } },
      innerLayouts: {}
    });
    const stored = sessionStore.current()!;
    expect(Object.keys(stored.workspaces)).toContain("workspace.1");
    expect(Object.keys(stored.workspaces)).not.toContain(orphanWorkspaceId);
  });

  it("restores from an existing session snapshot (outerLayout + innerLayouts)", async () => {
    const initial: FlmuxSessionSnapshot = {
      version: 4,
      appTitle: "flmux",
      outerLayout: {
        panels: {
          "workspace.alpha": {
            id: "workspace.alpha",
            contentComponent: "workspace",
            title: "Alpha"
          }
        }
      },
      workspaces: {
        "workspace.alpha": {
          title: "Alpha",
          defaultTitle: "Alpha",
          innerLayout: {
            panels: {
              "pane.persisted": {
                id: "pane.persisted",
                contentComponent: "cowsay",
                title: "Persisted Cowsay"
              }
            }
          }
        }
      }
    };

    const { authority } = await createTestAuthority({ initial });
    const bootstrap = authority.shellBootstrap();

    expect(bootstrap.snapshot.workspaces.map((ws) => ws.id)).toEqual(["workspace.alpha"]);
    expect(bootstrap.snapshot.panes["workspace.alpha"].map((pane) => pane.id)).toEqual(["pane.persisted"]);
    expect(bootstrap.innerLayouts["workspace.alpha"]).toBeDefined();
  });

  it("substitutes unknown pane kinds with placeholder during restore", async () => {
    const initial: FlmuxSessionSnapshot = {
      version: 4,
      appTitle: "flmux",
      outerLayout: {
        panels: {
          "workspace.alpha": { id: "workspace.alpha", contentComponent: "workspace", title: "Alpha" }
        }
      },
      workspaces: {
        "workspace.alpha": {
          title: "Alpha",
          defaultTitle: "Alpha",
          innerLayout: {
            panels: {
              "pane.ghost": {
                id: "pane.ghost",
                contentComponent: "bogus-kind",
                title: "Ghost"
              }
            }
          }
        }
      }
    };

    const { authority } = await createTestAuthority({ initial });
    const bootstrap = authority.shellBootstrap();
    const innerLayout = bootstrap.innerLayouts["workspace.alpha"] as {
      panels: { [id: string]: { contentComponent: string; params?: Record<string, unknown> } };
    };
    expect(innerLayout.panels["pane.ghost"].contentComponent).toBe("placeholder");
    expect(innerLayout.panels["pane.ghost"].params).toMatchObject({ originalKind: "bogus-kind" });
  });

  it("shellModel.path.* preload handler and router.pathCall drive identical core state", async () => {
    const { authority, terminalService } = await createTestAuthority();
    const preloadHandlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => authority.clientId,
      getCallerViewId: () => 1,
      paneOwners: new Map(),
      shellModelRouter: authority.router,
      terminalService,
      localExtensions: [],
      desktopAuthority: authority
    });

    await preloadHandlers["shellModel.path.call"]({ path: "/workspaces/new" });
    await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/workspaces/new"
    });

    // Seed workspace + two new workspaces = 3
    expect(authority.shellBootstrap().snapshot.workspaces).toHaveLength(3);
  });

  it("onClientRegister wires per-view shellCore.event forwarding, and detach tears it down", async () => {
    const { authority, clientRegistry } = await createTestAuthority();
    const received: SequencedShellCoreEvent[] = [];
    const viewId = 7;

    clientRegistry.attachRenderer(viewId, {
      sendProxy: {
        "terminal.event": () => {},
        "shellCore.event": (event) => {
          received.push(event);
        }
      }
    });

    const unsubscribers = new Map<number, () => void>();
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => authority.clientId,
      getCallerViewId: () => viewId,
      paneOwners: new Map(),
      shellModelRouter: authority.router,
      terminalService: createTerminalService(createInMemoryTerminalBackend()),
      localExtensions: [],
      desktopAuthority: authority,
      onClientRegister: (vId) => {
        const client = clientRegistry.resolveByViewId(vId);
        if (!client) {
          return;
        }
        const unsub = authority.subscribe((event) => client.bridge.sendProxy["shellCore.event"](event));
        unsubscribers.set(vId, unsub);
      }
    });

    handlers["flmux.client.register"]();
    expect(received).toHaveLength(0);

    await authority.shellModel.pathCall("/workspaces/new");
    expect(received.some((event) => event.topic === "workspace.added")).toBe(true);

    received.length = 0;
    unsubscribers.get(viewId)?.();
    await authority.shellModel.pathCall("/workspaces/new");
    expect(received).toHaveLength(0);
  });

  it("deleting the last workspace auto-reseeds so /status/workspace never throws", async () => {
    const { authority } = await createTestAuthority();
    const initialWorkspaceId = authority.shellBootstrap().snapshot.workspaces[0].id;

    await authority.shellModel.pathCall(`/workspaces/${initialWorkspaceId}/delete`);

    const bootstrap = authority.shellBootstrap();
    expect(bootstrap.snapshot.workspaces).toHaveLength(1);
    expect(bootstrap.snapshot.activeWorkspaceId).toBe(bootstrap.snapshot.workspaces[0].id);
    const status = await authority.shellModel.pathGet("/status/workspace");
    expect(status).toMatchObject({ ok: true, found: true });
  });

  it("terminal attach via shellModel.path.call populates paneOwners for event forwarding", async () => {
    const { authority, terminalService } = await createTestAuthority();
    const paneOwners = new Map<string, number>();
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => authority.clientId,
      getCallerViewId: () => 42,
      paneOwners,
      shellModelRouter: authority.router,
      terminalService,
      localExtensions: [],
      desktopAuthority: authority
    });

    const created = (await authority.shellModel.pathCall("/panes/new", {
      kind: "terminal"
    })) as { ok: true; value: { paneId: string } };
    const paneId = created.value.paneId;
    expect(paneOwners.has(paneId)).toBe(false);

    const attachResult = await handlers["shellModel.path.call"]({
      path: `/panes/${paneId}/terminal/attach`,
      args: {}
    });
    expect(attachResult.ok).toBe(true);
    expect(paneOwners.get(paneId)).toBe(42);
  });

  // Router goes onto the HTTP/WS wire (external, CLI). If router.pathCall
  // drops `caller`, every caller-dependent path (/bus/publish today; Phase B
  // adds /workspaces/{id}/setActive etc.) silently falls back to "no caller",
  // which external surfaces will hit first.
  it("router.pathCall forwards PathCallerContext to bus.publish", async () => {
    const { authority } = await createTestAuthority();
    const paneId = authority.shellBootstrap().snapshot.panes[
      authority.shellBootstrap().snapshot.workspaces[0].id
    ][0].id;

    const withoutCaller = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/bus/publish",
      args: { topic: "demo.ping", payload: { n: 1 } }
    });
    expect(withoutCaller).toMatchObject({ ok: false });

    const withCaller = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/bus/publish",
      args: { topic: "demo.ping", payload: { n: 1 } },
      caller: { sourcePaneId: paneId }
    });
    expect(withCaller).toMatchObject({ ok: true });
  });

  it("shellModel.path.call forwards PathCallerContext to bus.publish", async () => {
    const { authority } = await createTestAuthority();
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => authority.clientId,
      getCallerViewId: () => 1,
      paneOwners: new Map(),
      shellModelRouter: authority.router,
      terminalService: createTerminalService(createInMemoryTerminalBackend()),
      localExtensions: [],
      desktopAuthority: authority
    });

    const paneId = authority.shellBootstrap().snapshot.panes[authority.shellBootstrap().snapshot.workspaces[0].id][0].id;

    const withoutCaller = await handlers["shellModel.path.call"]({
      path: "/bus/publish",
      args: { topic: "demo.ping", payload: { n: 1 } }
    });
    expect(withoutCaller).toMatchObject({ ok: false });

    const withCaller = await handlers["shellModel.path.call"]({
      path: "/bus/publish",
      args: { topic: "demo.ping", payload: { n: 1 } },
      caller: { sourcePaneId: paneId }
    });
    expect(withCaller).toMatchObject({ ok: true });
  });

  it("pane.added event carries placement hint for user-initiated /panes/new", async () => {
    const { authority } = await createTestAuthority();
    const captured: SequencedShellCoreEvent[] = [];
    authority.subscribe((event) => captured.push(event));

    const reference = authority.shellBootstrap().snapshot.panes[
      authority.shellBootstrap().snapshot.workspaces[0].id
    ][0].id;

    await authority.shellModel.pathCall("/panes/new", {
      kind: "browser",
      place: "right",
      referencePaneId: reference
    });

    const paneAdded = captured
      .filter((event): event is SequencedShellCoreEvent & { topic: "pane.added" } => event.topic === "pane.added")
      .at(-1)!;
    expect(paneAdded.payload.place).toBe("right");
    expect(paneAdded.payload.referencePaneId).toBe(reference);
  });

  // /panes/new without referencePaneId is the header-action "+" hot path
  // (workbench.ts:383). Core must accept it and emit pane.added with place
  // preserved + referencePaneId undefined so the renderer can fall back to
  // innerApi.activePanel — or, when even activePanel is absent (no-pane
  // workspace momentarily), pass position:undefined to dockview.
  it("pane.added carries place but no referencePaneId for header-action /panes/new", async () => {
    const { authority } = await createTestAuthority();
    const workspaceId = authority.shellBootstrap().snapshot.workspaces[0].id;

    for (const pane of authority.shellBootstrap().snapshot.panes[workspaceId]) {
      await authority.shellModel.pathCall(`/panes/${pane.id}/close`);
    }
    const cleared = authority.shellBootstrap().snapshot.panes[workspaceId];
    expect(cleared).toEqual([]);

    const captured: SequencedShellCoreEvent[] = [];
    authority.subscribe((event) => captured.push(event));

    const result = await authority.shellModel.pathCall("/panes/new", {
      kind: "browser",
      place: "right"
    });
    expect(result.ok).toBe(true);

    const paneAdded = captured
      .filter((event): event is SequencedShellCoreEvent & { topic: "pane.added" } => event.topic === "pane.added")
      .at(-1)!;
    expect(paneAdded.payload.place).toBe("right");
    expect(paneAdded.payload.referencePaneId).toBeUndefined();
  });
});
