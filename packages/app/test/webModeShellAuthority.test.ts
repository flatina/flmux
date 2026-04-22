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
          paneCount: 1
        }
      }
    ]);

    // HTTP envelope (router) deliberately drops caller — external HTTP
    // can't reach implicit-current paths. Go through shellModel directly
    // to exercise the narrowing with a preload-equivalent caller.
    const workspace = await authority.shellModel.pathGet("/status/workspace", { attachmentId: "server" });
    expect(workspace).toEqual({
      ok: true,
      found: true,
      value: {
        id: "workspace.1",
        title: "Workspace 1",
        defaultTitle: "Workspace 1",
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

    await expect(
      authority.router.pathGet({
        clientId: rendererClient.clientId,
        path: "/status/workspace"
      })
    ).rejects.toThrow(`Unknown flmux client: ${rendererClient.clientId}`);
  });

  it("shellBootstrap(attachmentId) seeds a fresh slot and captures seqStart after mutation", async () => {
    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });
    await authority.start("http://127.0.0.1:4321");

    // Subscribe BEFORE bootstrap to count active-change emits targeted at
    // the new slot — preflight #2 "authority injects targetAttachmentId"
    // says bootstrapAttachment emits exactly one `workspace.activeChanged`
    // on first call, zero on idempotent re-entry.
    const activeChangesForAlpha: number[] = [];
    const unsub = authority.subscribe((event) => {
      if (event.topic === "workspace.activeChanged" && event.targetAttachmentId === "web_alpha") {
        activeChangesForAlpha.push(event.seq);
      }
    });

    const fresh = authority.shellBootstrap("web_alpha");
    expect(fresh.attachmentId).toBe("web_alpha");
    expect(fresh.snapshot.activeWorkspaceId).toBe("workspace.1");
    expect(fresh.outerLayout).toBeNull();
    expect(fresh.innerLayouts).toEqual({});
    expect(activeChangesForAlpha).toHaveLength(1);
    // seqStart captured AFTER the bootstrap mutation emit — the emitted
    // active-change must have seq ≤ seqStart so the client's seq-gate
    // filters it (avoids double-apply with the snapshot's activeWorkspaceId).
    expect(activeChangesForAlpha[0]).toBeLessThanOrEqual(fresh.seqStart);

    const again = authority.shellBootstrap("web_alpha");
    expect(again.snapshot.activeWorkspaceId).toBe("workspace.1");
    expect(again.seqStart).toBe(fresh.seqStart);
    expect(activeChangesForAlpha).toHaveLength(1);

    unsub();
  });

  it("shellBootstrap returns synchronously — preflight #1 §S3 parity with desktop", async () => {
    const clientRegistry = new FlmuxClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "C:/project",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });
    await authority.start("http://127.0.0.1:4321");

    const result = authority.shellBootstrap("web_sync_check");
    expect(result).not.toHaveProperty("then");
    expect(typeof result.seqStart).toBe("number");
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

    const panes = (await authority.shellModel.pathGet("/status/panes", { attachmentId: "server" })) as {
      ok: true;
      found: true;
      value: Record<string, { kind: string }>;
    };
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
      version: "0.1.0",
      runtimeManifest: {
        id: "sample.counter",
        name: "sample.counter",
        version: "0.1.0",
        apiVersion: 2,
        entrypoints: { renderer: "index.js" },
        panes: [{ kind: "counter", defaultTitle: "Counter" }]
      },
      rendererEntryRelativePath: "index.js",
      cliEntryRelativePath: null,
      serverEntryRelativePath: null,
      origin: "source",
      originPath: resolve(counterDistRoot, ".."),
      resolveRuntimeFile: () => null,
      resolveEntryImportUrl: async (relativePath) => {
        const { pathToFileURL } = await import("node:url");
        return pathToFileURL(resolve(counterDistRoot, relativePath)).href;
      }
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

    const created = (await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "counter", count: 7 }
    })) as { ok: true; value: { pane: { id: string } } };
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

    const result = (await authority.router.pathCall({
      clientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "cowsay" }
    })) as { ok: boolean; error?: string };
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
    version: options.version,
    runtimeManifest: {
      id: options.id,
      name: options.id,
      version: options.version,
      apiVersion: 2,
      entrypoints: { renderer: "index.js" },
      panes: options.panes
    },
    rendererEntryRelativePath: "index.js",
    cliEntryRelativePath: null,
    serverEntryRelativePath: null,
    origin: "source",
    originPath: `/fake/${options.id}`,
    resolveRuntimeFile: () => null,
    resolveEntryImportUrl: async () => `fake://${options.id}/index.js`
  };
}
