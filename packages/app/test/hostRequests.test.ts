import { describe, expect, it, mock } from "bun:test";
import type { FlmuxSessionSaveLayouts } from "../src/shared/rendererBridge";
import { createFlmuxHostRequestHandlers } from "../src/main/hostRequests";

describe("flmux host requests", () => {
  it("binds registration and terminal ownership to the caller view", async () => {
    const paneOwners = new Map<string, number>();
    const registerClient = mock((viewId: number) => ({ clientId: `client-${viewId}` }));
    const onClientRegister = mock((_viewId: number) => {});
    const create = mock(async (input: { paneId?: string }) => ({
      ok: true as const,
      rootKey: "root_123",
      runtimeId: "term_123",
      history: "",
      terminal: {
        rootKey: "root_123",
        rootDir: "C:/workspace",
        runtimeId: "term_123",
        cwd: "C:/workspace",
        alive: true,
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z",
        commandCount: 0
      }
    }));
    const adoptByPaneId = mock(async () => ({
      ok: true as const,
      outcome: "adopted" as const,
      rootKey: "root_123",
      runtimeId: "term_123",
      history: "",
      terminal: {
        rootKey: "root_123",
        rootDir: "C:/workspace",
        runtimeId: "term_123",
        cwd: "C:/workspace",
        alive: true,
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z",
        commandCount: 0
      }
    }));

    const pathGet = mock(async () => ({ ok: true as const, found: false, value: undefined }));
    const pathList = mock(async () => ({ ok: true as const, found: false, entries: [] }));
    const pathSet = mock(async () => ({ ok: true as const, value: null }));
    const pathCall = mock(async () => ({ ok: true as const, value: null }));
    const shellModelStub = {
      pathGet,
      pathList,
      pathSet,
      pathCall
    };

    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:4321",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => null,
      getCallerViewId: () => 77,
      paneOwners,
      shellModelRouter: {
        registerClient,
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      },
      shellModel: shellModelStub,
      terminalService: {
        create,
        adoptByPaneId,
        write: async () => ({ ok: true, accepted: true, runtimeId: "term_123", history: "", terminal: null }),
        resize: async () => ({ ok: true, accepted: true, runtimeId: "term_123", terminal: null }),
        history: async () => ({ ok: true, runtimeId: "term_123", data: "" }),
        kill: async () => ({ ok: true, rootKey: "root_123", runtimeId: "term_123", killed: true, terminal: null }),
        listRoots: async () => [],
        subscribe: () => () => {},
        dispose: () => {}
      },
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    expect(handlers["flmux.getConfig"]()).toMatchObject({
      mode: "desktop",
      appOrigin: "http://127.0.0.1:4321",
      projectDir: "C:/project",
      authorityClientId: null
    });
    expect(handlers["flmux.client.register"]({})).toEqual({
      status: "ok",
      clientId: "client-77"
    });
    expect(onClientRegister).toHaveBeenCalledWith(77, undefined);

    await handlers["flmux.terminal.create"]({
      paneId: "pane.alpha",
      rootDir: "C:/workspace",
      cwd: "."
    });
    expect(paneOwners.get("pane.alpha")).toBe(77);

    await handlers["flmux.terminal.adopt"]({
      paneId: "pane.beta",
      rootDir: "C:/workspace"
    });
    expect(paneOwners.get("pane.beta")).toBe(77);
    expect(registerClient).toHaveBeenCalledWith(77);
    expect(create).toHaveBeenCalledTimes(1);
    expect(adoptByPaneId).toHaveBeenCalledTimes(1);
  });

  it("web mode: shellModel.path.* routes through the injected shellModel; bootstrap stays desktop-only", async () => {
    const pathGet = mock(async () => ({ ok: true as const, found: true, value: { title: "Test" } }));
    const pathCall = mock(async () => ({ ok: true as const, value: null }));
    const shellModelStub = {
      pathGet,
      pathList: async () => ({ ok: true as const, found: false, entries: [] }),
      pathSet: async () => ({ ok: true as const, value: null }),
      pathCall
    };
    const onClientRegister = mock((_viewId: number) => {});

    const handlers = createFlmuxHostRequestHandlers({
      mode: "web",
      getAppOrigin: () => "http://127.0.0.1:4321",
      getProjectDir: () => "C:/project",
      getAuthorityClientId: () => "server_authority",
      getCallerViewId: () => 5,
      paneOwners: new Map(),
      shellModelRouter: {
        registerClient: () => ({ clientId: "client-5" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      },
      shellModel: shellModelStub,
      terminalService: {
        create: async () => {
          throw new Error("not used");
        },
        adoptByPaneId: async () => ({ ok: true, outcome: "not_found" }),
        write: async () => ({ ok: true, accepted: true, runtimeId: "term_123", history: "", terminal: null }),
        resize: async () => ({ ok: true, accepted: true, runtimeId: "term_123", terminal: null }),
        history: async () => ({ ok: true, runtimeId: "term_123", data: "" }),
        kill: async () => ({ ok: true, rootKey: "root_123", runtimeId: "term_123", killed: true, terminal: null }),
        listRoots: async () => [],
        subscribe: () => () => {},
        dispose: () => {}
      },
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    // Browser-mounted FlmuxWorkbench needs shellModel.path.* to work in
    // web mode — the mutation path that lives inside workbench.ts.
    expect(await handlers["shellModel.path.get"]({ path: "/status/app" }))
      .toEqual({ ok: true, found: true, value: { title: "Test" } });
    expect(pathGet).toHaveBeenCalledWith("/status/app");

    expect(await handlers["shellModel.path.call"]({ path: "/panes/new", args: { kind: "browser" } }))
      .toEqual({ ok: true, value: null });

    // `flmux.shellBootstrap` is preload-RPC-only and requires the desktop
    // authority — web clients reach it via HTTP `/api/shell/bootstrap`.
    expect(() => handlers["flmux.shellBootstrap"]()).toThrow(
      "flmux.shellBootstrap is only available in desktop mode"
    );

    // Web `flmux.client.register` requires an attachmentId binding —
    // bare `{}` is a protocol violation (browser must have done HTTP
    // bootstrap first).
    const layouts: FlmuxSessionSaveLayouts = { outerLayout: null, innerLayouts: {} };
    expect(handlers["flmux.layout.push"](layouts)).toEqual({ ok: true });
  });

  it("desktop register returns {status: 'ok'} when no binding is passed (invariant guard)", () => {
    const onClientRegister = mock((_viewId: number) => {});
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => null,
      getCallerViewId: () => 1,
      paneOwners: new Map(),
      shellModelRouter: {
        registerClient: () => ({ clientId: "client-1" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      },
      shellModel: {
        pathGet: async () => ({ ok: true, found: false, value: undefined }),
        pathList: async () => ({ ok: true, found: false, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall: async () => ({ ok: true, value: null })
      },
      terminalService: {
        create: async () => {
          throw new Error("not used");
        },
        adoptByPaneId: async () => ({ ok: true, outcome: "not_found" }),
        write: async () => ({ ok: true, accepted: true, runtimeId: "term_x", history: "", terminal: null }),
        resize: async () => ({ ok: true, accepted: true, runtimeId: "term_x", terminal: null }),
        history: async () => ({ ok: true, runtimeId: "term_x", data: "" }),
        kill: async () => ({ ok: true, rootKey: "root_x", runtimeId: "term_x", killed: true, terminal: null }),
        listRoots: async () => [],
        subscribe: () => () => {},
        dispose: () => {}
      },
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    // Desktop preload never passes a binding — return must always be "ok".
    // Guards the invariant behind workbench.ts's desktop-path `status !== "ok"` throw.
    expect(handlers["flmux.client.register"]({})).toEqual({ status: "ok", clientId: "client-1" });
    expect(onClientRegister).toHaveBeenCalledWith(1, undefined);
  });

  it("web register without binding rejects with a clear 'must POST /api/shell/bootstrap' error", () => {
    const onClientRegister = mock((_viewId: number, _binding?: { attachmentId: string; lastAppliedSeq: number }): "rebootstrap-required" | void => {
      throw new Error(
        "flmux.client.register: web clients must pass {attachmentId, lastAppliedSeq} obtained from /api/shell/bootstrap"
      );
    });
    const handlers = createFlmuxHostRequestHandlers({
      mode: "web",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => "server_authority",
      getCallerViewId: () => 9,
      paneOwners: new Map(),
      shellModelRouter: {
        registerClient: () => ({ clientId: "client-9" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      },
      shellModel: {
        pathGet: async () => ({ ok: true, found: false, value: undefined }),
        pathList: async () => ({ ok: true, found: false, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall: async () => ({ ok: true, value: null })
      },
      terminalService: {
        create: async () => {
          throw new Error("not used");
        },
        adoptByPaneId: async () => ({ ok: true, outcome: "not_found" }),
        write: async () => ({ ok: true, accepted: true, runtimeId: "term_y", history: "", terminal: null }),
        resize: async () => ({ ok: true, accepted: true, runtimeId: "term_y", terminal: null }),
        history: async () => ({ ok: true, runtimeId: "term_y", data: "" }),
        kill: async () => ({ ok: true, rootKey: "root_y", runtimeId: "term_y", killed: true, terminal: null }),
        listRoots: async () => [],
        subscribe: () => () => {},
        dispose: () => {}
      },
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    expect(() => handlers["flmux.client.register"]({})).toThrow("/api/shell/bootstrap");
  });
});
