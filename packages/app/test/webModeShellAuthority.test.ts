import { describe, expect, it } from "bun:test";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import { createWebModeShellAuthority } from "../src/main/webModeShellAuthority";
import type { FlmuxRendererBridge } from "../src/shared/rendererBridge";

describe("web mode shell authority", () => {
  it("routes external model calls through a single server-owned authority", async () => {
    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });

    await authority.start("http://127.0.0.1:4321");

    const rendererBridge: FlmuxRendererBridge = {
      requestProxy: {
        "shellModel.path.get": async () => ({ ok: true, found: false, value: null }),
        "shellModel.path.list": async () => ({ ok: true, found: false, entries: [] }),
        "shellModel.path.set": async () => ({ ok: false, code: "NOT_WRITABLE", error: "unused" }),
        "shellModel.path.call": async () => ({ ok: false, code: "NOT_CALLABLE", error: "unused" })
      },
      sendProxy: {
        "terminal.event": () => {}
      }
    };
    clientRegistry.attachRenderer(101, rendererBridge);
    const rendererClient = authority.router.registerClient(101);
    expect(rendererClient.clientId).toMatch(/^client_/);

    const listedClients = await authority.router.listClients();
    expect(listedClients).toEqual([
      {
        clientId: authority.clientId,
        viewId: 0,
        workspace: {
          id: "workspace.1",
          title: "Workspace 1",
          activePaneId: expect.any(String),
          paneCount: 1
        }
      }
    ]);

    const workspace = await authority.router.pathGet({
      clientId: authority.clientId,
      path: "/status/workspace"
    });
    expect(workspace).toEqual({
      ok: true,
      found: true,
      value: {
        id: "workspace.1",
        title: "Workspace 1",
        activePaneId: expect.any(String),
        paneCount: 1
      }
    });

    const browserPane = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: {
        kind: "browser",
        url: "/__flmux/internal/start?workspace=workspace.1"
      }
    });
    expect(browserPane).toMatchObject({
      ok: true,
      value: {
        pane: {
          kind: "browser",
          browser: {
            url: "http://127.0.0.1:4321/__flmux/internal/start?workspace=workspace.1"
          }
        }
      }
    });

    await expect(authority.router.pathGet({
      clientId: rendererClient.clientId,
      path: "/status/workspace"
    })).rejects.toThrow(`Unknown flmux client: ${rendererClient.clientId}`);
  });
});
