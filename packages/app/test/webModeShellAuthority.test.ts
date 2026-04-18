import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import type { DiscoveredLocalExtension } from "../src/main/localExtensions";
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
      sendProxy: {
        "terminal.event": () => {},
        "shellCore.event": () => {}
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
          defaultTitle: "Workspace 1",
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
        defaultTitle: "Workspace 1",
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

  it("registers manifest-declared extension pane kinds", async () => {
    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      localExtensions: [
        createFakeDiscoveredExtension({
          id: "sample.cowsay",
          version: "0.1.0",
          panes: [{ kind: "cowsay", defaultTitle: "Cowsay" }]
        })
      ]
    });

    await authority.start("http://127.0.0.1:4322");

    const created = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "cowsay" }
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        pane: {
          kind: "cowsay",
          title: "Cowsay"
        }
      }
    });

    const panes = await authority.router.pathGet({
      clientId: authority.clientId,
      path: "/status/panes"
    }) as { ok: true; found: true; value: Record<string, { kind: string }> };
    const kinds = Object.values(panes.value).map((pane) => pane.kind);
    expect(kinds).toContain("cowsay");
  });

  it("forwards extension pathMount hooks to the server authority", async () => {
    // Points at the real built counter bundle — exercises the default production
    // importer end-to-end (pathToFileURL + dynamic import + @flmux/extension-api
    // bare specifier resolution via Bun workspace).
    const counterDistRoot = resolve(__dirname, "../../../extensions/counter/dist");
    const counterExtension: DiscoveredLocalExtension = {
      id: "sample.counter",
      name: "sample.counter",
      rootDir: resolve(counterDistRoot, ".."),
      runtimeRootDir: counterDistRoot,
      runtimeManifestPath: resolve(counterDistRoot, "manifest.json"),
      runtimeManifest: {
        id: "sample.counter",
        name: "sample.counter",
        version: "0.1.0",
        apiVersion: 2,
        entrypoints: { renderer: "index.js" },
        panes: [{ kind: "counter", defaultTitle: "Counter" }]
      },
      rendererEntryPath: resolve(counterDistRoot, "index.js"),
      cliEntryPath: null,
      version: "0.1.0"
    };

    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      localExtensions: [counterExtension]
    });

    await authority.start("http://127.0.0.1:4324");

    const created = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "counter", count: 7 }
    }) as { ok: true; value: { pane: { id: string } } };
    const paneId = created.value.pane.id;

    const initialState = await authority.router.pathGet({
      clientId: authority.clientId,
      path: `/panes/${paneId}/counter/count`
    });
    expect(initialState).toEqual({ ok: true, found: true, value: 7 });

    const setResult = await authority.router.pathSet({
      clientId: authority.clientId,
      path: `/panes/${paneId}/counter/count`,
      value: 42
    });
    expect(setResult).toEqual({ ok: true, value: 42 });

    const afterSet = await authority.router.pathGet({
      clientId: authority.clientId,
      path: `/panes/${paneId}/counter/count`
    });
    expect(afterSet).toEqual({ ok: true, found: true, value: 42 });

    const status = await authority.router.pathGet({
      clientId: authority.clientId,
      path: `/status/panes/${paneId}/counter/count`
    });
    expect(status).toEqual({ ok: true, found: true, value: 42 });
  });

  it("rejects /panes/new for pane kinds not declared by any built-in or extension", async () => {
    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });

    await authority.start("http://127.0.0.1:4323");

    const result = await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "cowsay" }
    }) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/pane kind/i);
  });
});

function createFakeDiscoveredExtension(options: {
  id: string;
  version: string;
  panes: Array<{ kind: string; defaultTitle?: string }>;
}): DiscoveredLocalExtension {
  return {
    id: options.id,
    name: options.id,
    rootDir: `/fake/${options.id}`,
    runtimeRootDir: `/fake/${options.id}/dist`,
    runtimeManifestPath: `/fake/${options.id}/dist/manifest.json`,
    runtimeManifest: {
      id: options.id,
      name: options.id,
      version: options.version,
      apiVersion: 2,
      entrypoints: { renderer: "index.js" },
      panes: options.panes
    },
    rendererEntryPath: `/fake/${options.id}/dist/index.js`,
    cliEntryPath: null,
    version: options.version
  };
}
