import { describe, expect, it, mock } from "bun:test";
import type { FlmuxSessionSaveLayouts } from "../src/shared/rendererBridge";
import { createFlmuxHostRequestHandlers } from "../src/main/hostRequests";

describe("flmux host requests", () => {
  it("binds registration and /terminal/attach subscription to the caller view", async () => {
    const paneSubscribers = new Map<string, Set<number>>();
    const registerClient = mock((viewId: number) => ({ clientId: `client-${viewId}` }));
    const onClientRegister = mock((_viewId: number) => {});

    const pathGet = mock(async () => ({ ok: true as const, found: false, value: undefined }));
    const pathList = mock(async () => ({ ok: true as const, found: false, entries: [] }));
    const pathSet = mock(async () => ({ ok: true as const, value: null }));
    const pathCall = mock(async () => ({ ok: true as const, value: { runtimeId: "term_123" } }));
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
      paneSubscribers,
      resolveShellModelRouter: () => ({
        registerClient,
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => shellModelStub,
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
    expect(registerClient).toHaveBeenCalledWith(77);

    // Attach path pre-subscribes the caller viewId before the RPC; the
    // model layer then owns adopt-or-create routing through shellCore.
    await handlers["shellModel.path.call"]({ path: "/panes/pane.alpha/terminal/attach" });
    expect(paneSubscribers.get("pane.alpha")?.has(77)).toBe(true);
    expect(pathCall).toHaveBeenCalledWith("/panes/pane.alpha/terminal/attach", undefined, undefined);
  });

  it("rolls back the attach pre-subscribe when the path.call fails", async () => {
    const paneSubscribers = new Map<string, Set<number>>();
    const pathCall = mock(async () => ({ ok: false as const, code: "NOT_FOUND" as const, error: "missing" }));
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => null,
      getCallerViewId: () => 42,
      paneSubscribers,
      resolveShellModelRouter: () => ({
        registerClient: () => ({ clientId: "client-42" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => ({
        pathGet: async () => ({ ok: true, found: false, value: undefined }),
        pathList: async () => ({ ok: true, found: false, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall
      }),
      localExtensions: [],
      desktopAuthority: null
    });

    const result = await handlers["shellModel.path.call"]({ path: "/panes/pane.gone/terminal/attach" });
    expect(result.ok).toBe(false);
    expect(paneSubscribers.has("pane.gone")).toBe(false);
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
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => ({
        registerClient: () => ({ clientId: "client-5" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => shellModelStub,
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    // Browser-mounted FlmuxWorkbench needs shellModel.path.* to work in
    // web mode — the mutation path that lives inside workbench.ts.
    expect(await handlers["shellModel.path.get"]({ path: "/status/app" })).toEqual({
      ok: true,
      found: true,
      value: { title: "Test" }
    });
    expect(pathGet).toHaveBeenCalledWith("/status/app", undefined);

    expect(await handlers["shellModel.path.call"]({ path: "/panes/new", args: { kind: "browser" } })).toEqual({
      ok: true,
      value: null
    });

    // `flmux.shellBootstrap` is preload-RPC-only and requires the desktop
    // authority — web clients reach it via HTTP `/api/shell/bootstrap`.
    expect(() => handlers["flmux.shellBootstrap"]()).toThrow("flmux.shellBootstrap is only available in desktop mode");

    // Web `flmux.client.register` requires an attachmentId binding —
    // bare `{}` is a protocol violation (browser must have done HTTP
    // bootstrap first).
    const layouts: FlmuxSessionSaveLayouts = { outerLayout: null, innerLayouts: {} };
    expect(handlers["flmux.layout.push"](layouts)).toEqual({ ok: true });
  });

  it("preload injects caller.attachmentId on every shellModel.path.* RPC (get/list/set/call)", async () => {
    const pathGet = mock(async () => ({ ok: true as const, found: true, value: null }));
    const pathList = mock(async () => ({ ok: true as const, found: true, entries: [] }));
    const pathSet = mock(async () => ({ ok: true as const, value: null }));
    const pathCall = mock(async () => ({ ok: true as const, value: null }));
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => null,
      getCallerViewId: () => 1,
      getCallerAttachmentId: () => "local",
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => ({
        registerClient: () => ({ clientId: "client-1" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => ({ pathGet, pathList, pathSet, pathCall }),
      localExtensions: [],
      desktopAuthority: null
    });

    await handlers["shellModel.path.get"]({ path: "/status/workspace" });
    await handlers["shellModel.path.list"]({ path: "/panes" });
    await handlers["shellModel.path.set"]({ path: "/title", value: "Renamed" });
    await handlers["shellModel.path.call"]({ path: "/panes/new", args: { kind: "browser" } });

    // Preload path = shellModel sees caller.attachmentId, so implicit-current
    // narrowing doesn't reject. External HTTP callers (no getCallerAttachmentId
    // equivalent) are the ones that hit INVALID_VALUE at the model layer.
    expect(pathGet).toHaveBeenCalledWith("/status/workspace", { attachmentId: "local" });
    expect(pathList).toHaveBeenCalledWith("/panes", { attachmentId: "local" });
    expect(pathSet).toHaveBeenCalledWith("/title", "Renamed", { attachmentId: "local" });
    expect(pathCall).toHaveBeenCalledWith("/panes/new", { kind: "browser" }, { attachmentId: "local" });
  });

  it("desktop register returns {status: 'ok'} when no binding is passed (invariant guard)", () => {
    const onClientRegister = mock((_viewId: number) => {});
    const handlers = createFlmuxHostRequestHandlers({
      mode: "desktop",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => null,
      getCallerViewId: () => 1,
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => ({
        registerClient: () => ({ clientId: "client-1" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => ({
        pathGet: async () => ({ ok: true, found: false, value: undefined }),
        pathList: async () => ({ ok: true, found: false, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall: async () => ({ ok: true, value: null })
      }),
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
    const onClientRegister = mock(
      (
        _viewId: number,
        _binding?: { attachmentId: string; lastAppliedSeq: number }
      ): "rebootstrap-required" | undefined => {
        throw new Error(
          "flmux.client.register: web clients must pass {attachmentId, lastAppliedSeq} obtained from /api/shell/bootstrap"
        );
      }
    );
    const handlers = createFlmuxHostRequestHandlers({
      mode: "web",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => "server_authority",
      getCallerViewId: () => 9,
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => ({
        registerClient: () => ({ clientId: "client-9" }),
        listClients: async () => [],
        pathGet: async () => ({ ok: true }),
        pathList: async () => ({ ok: true }),
        pathSet: async () => ({ ok: true }),
        pathCall: async () => ({ ok: true })
      }),
      resolveShellModel: () => ({
        pathGet: async () => ({ ok: true, found: false, value: undefined }),
        pathList: async () => ({ ok: true, found: false, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall: async () => ({ ok: true, value: null })
      }),
      localExtensions: [],
      desktopAuthority: null,
      onClientRegister
    });

    expect(() => handlers["flmux.client.register"]({})).toThrow("/api/shell/bootstrap");
  });

  it("web register returns rebootstrap-required when the attachmentId is unknown server-side", () => {
    // Simulates a browser replaying an attachmentId the server no longer
    // knows — attachment aged out during grace, never minted, or a
    // scripted client sent a bogus id. The register handler must signal
    // recovery (not raw RPC error) so the client reloads via HTTP
    // bootstrap (Codex B2 Phase 1 review B1).
    const handlers = createFlmuxHostRequestHandlers({
      mode: "web",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => "server_authority",
      getCallerViewId: () => 11,
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => null,
      resolveShellModel: () => null,
      localExtensions: [],
      desktopAuthority: null
    });

    expect(handlers["flmux.client.register"]({ attachmentId: "web_bogus", lastAppliedSeq: 0 })).toEqual({
      status: "rebootstrap-required"
    });
  });

  it("web shellModel.path.* rejects before register (attachment not bound)", async () => {
    const handlers = createFlmuxHostRequestHandlers({
      mode: "web",
      getAppOrigin: () => "http://127.0.0.1:0",
      getProjectDir: () => ".",
      getAuthorityClientId: () => "server_authority",
      getCallerViewId: () => 13,
      paneSubscribers: new Map(),
      resolveShellModelRouter: () => null,
      resolveShellModel: () => null,
      localExtensions: [],
      desktopAuthority: null
    });

    // Throws synchronously (requireShellModel is called before the
    // handler returns a Promise) — use the sync `toThrow` matcher.
    expect(() => handlers["shellModel.path.get"]({ path: "/workspaces" })).toThrow("attachment not bound");
  });
});
