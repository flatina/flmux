import { describe, expect, it, mock } from "bun:test";
import type { FlmuxSessionSnapshot } from "../src/shared/session";
import { createFlmuxHostRequestHandlers } from "../src/main/hostRequests";

describe("flmux host requests", () => {
  it("binds registration and terminal ownership to the caller view", async () => {
    const paneOwners = new Map<string, number>();
    const registerClient = mock((viewId: number) => ({ clientId: `client-${viewId}` }));
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
      sessionStore: {
        load: async () => null,
        save: async () => {}
      }
    });

    expect(handlers["flmux.getConfig"]()).toMatchObject({
      mode: "desktop",
      appOrigin: "http://127.0.0.1:4321",
      projectDir: "C:/project",
      authorityClientId: null
    });
    expect(handlers["flmux.client.register"]()).toEqual({
      clientId: "client-77"
    });

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

  it("keeps session persistence out of web mode", async () => {
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
      sessionStore: null
    });

    const snapshot: FlmuxSessionSnapshot = {
      version: 2,
      appTitle: "flmux",
      activeWorkspaceId: "workspace.1",
      workspaces: {
        "workspace.1": {
          title: "Workspace 1",
          layout: null
        }
      }
    };

    expect(await handlers["flmux.session.load"]()).toBeNull();
    await expect(handlers["flmux.session.save"](snapshot)).rejects.toThrow(
      "Session persistence is only available in desktop mode"
    );
  });
});
