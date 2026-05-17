import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { ClientRegistry } from "../src/main/clientRegistry";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import type { DiscoveredLocalExtension } from "../src/main/localExtensions";
import { createWebModeShellAuthority } from "../src/main/webModeShellAuthority";
import type { FlmuxSessionSnapshot } from "../src/shared/session";

describe("web mode shell authority", () => {
  it("routes external model calls through a single server-owned authority", async () => {
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });

    await authority.start("http://127.0.0.1:4321");

    clientRegistry.attachLive("web_test", 101);
    const rendererClient = authority.router.registerClient(101, "web_test");
    expect(rendererClient.clientId).toBe("web_test");

    const listedClients = await authority.router.listClients();
    expect(listedClients).toEqual([
      {
        authorityClientId: authority.clientId,
        viewId: 0,
        workspace: {
          id: "workspace.1",
          title: "Workspace 1",
          defaultTitle: "Workspace 1",
          paneCount: 0
        }
      }
    ]);

    // HTTP envelope (router) deliberately drops caller — external HTTP
    // can't reach implicit-current paths. Go through shellModel directly
    // to exercise the narrowing with a preload-equivalent caller.
    const workspace = await authority.shellModel.pathGet("/status/workspace", { slotKey: "server" });
    expect(workspace).toEqual({
      ok: true,
      found: true,
      value: {
        id: "workspace.1",
        title: "Workspace 1",
        defaultTitle: "Workspace 1",
        paneCount: 0
      }
    });

    const browserPane = await authority.router.pathCall({
      authorityClientId: authority.clientId,
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
        authorityClientId: rendererClient.clientId,
        path: "/status/workspace"
      })
    ).rejects.toThrow(`Unknown flmux client: ${rendererClient.clientId}`);
  });

  it("shellBootstrap(clientId) seeds a fresh slot and captures seqStart after mutation", async () => {
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });
    await authority.start("http://127.0.0.1:4321");

    // Subscribe BEFORE bootstrap to count active-change emits targeted at
    // the new slot — preflight #2 "authority injects targetClientId"
    // says bootstrapClient emits exactly one `workspace.activeChanged`
    // on first call, zero on idempotent re-entry.
    const activeChangesForAlpha: number[] = [];
    const unsub = authority.subscribe((event) => {
      if (event.topic === "workspace.activeChanged" && event.targetClientId === "web_alpha") {
        activeChangesForAlpha.push(event.seq);
      }
    });

    const fresh = authority.shellBootstrap("web_alpha");
    expect(fresh.resumeToken).toBe("web_alpha");
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

  it("shellBootstrap reflects the latest persistSession layouts (refresh within authority lifetime)", async () => {
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const saved: FlmuxSessionSnapshot[] = [];
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      sessionStore: {
        load: async () => null,
        save: async (snapshot) => {
          saved.push(snapshot);
        }
      }
    });
    await authority.start("http://127.0.0.1:4321");

    const initial = authority.shellBootstrap("web_layout_a");
    expect(initial.outerLayout).toBeNull();
    expect(initial.innerLayouts).toEqual({});

    const outerLayout = { panels: { "workspace.1": { id: "workspace.1" } }, grid: { root: "workspace.1" } };
    const innerLayouts = { "workspace.1": { panels: { "pane.1": { id: "pane.1" } }, grid: { root: "pane.1" } } };
    await authority.persistSession!({ outerLayout, innerLayouts });
    expect(saved).toHaveLength(1);

    const refreshed = authority.shellBootstrap("web_layout_b");
    expect(refreshed.outerLayout).toEqual(outerLayout);
    expect(refreshed.innerLayouts).toEqual(innerLayouts);
  });

  it("shellBootstrap returns synchronously — preflight #1 §S3 parity with desktop", async () => {
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
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
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
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
      authorityClientId: authority.clientId,
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

    const panes = (await authority.shellModel.pathGet("/status/panes", { slotKey: "server" })) as {
      ok: true;
      found: true;
      value: Record<string, { kind: string }>;
    };
    const kinds = Object.values(panes.value).map((pane) => pane.kind);
    expect(kinds).toContain("cowsay");
  });

  it("forwards extension pathMount hooks to the server authority", async () => {
    // Points at the real built scratchpad bundle — exercises the default production
    // importer end-to-end (pathToFileURL + dynamic import + @flmux/extension-api
    // bare specifier resolution via Bun workspace).
    const scratchpadDistRoot = resolve(__dirname, "../../../extensions/scratchpad/dist");
    const scratchpadExtension: DiscoveredLocalExtension = {
      id: "sample.scratchpad",
      name: "sample.scratchpad",
      version: "0.1.0",
      runtimeManifest: {
        id: "sample.scratchpad",
        name: "sample.scratchpad",
        version: "0.1.0",
        apiVersion: 2,
        entrypoints: { renderer: "index.js", server: "server.js" },
        panes: [{ kind: "scratchpad", defaultTitle: "Scratchpad" }]
      },
      rendererEntryRelativePath: "index.js",
      cliEntryRelativePath: null,
      serverEntryRelativePath: "server.js",
      origin: "source",
      originPath: resolve(scratchpadDistRoot, ".."),
      resolveRuntimeFile: () => null,
      resolveEntryImportUrl: async (relativePath) => {
        const { pathToFileURL } = await import("node:url");
        return pathToFileURL(resolve(scratchpadDistRoot, relativePath)).href;
      }
    };

    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      localExtensions: [scratchpadExtension]
    });

    await authority.start("http://127.0.0.1:4324");

    const created = (await authority.router.pathCall({
      authorityClientId: authority.clientId,
      path: "/panes/new",
      args: { kind: "scratchpad", note: "hello" }
    })) as { ok: true; value: { pane: { id: string } } };
    const paneId = created.value.pane.id;

    const initialState = await authority.router.pathGet({
      authorityClientId: authority.clientId,
      path: `/panes/${paneId}/scratchpad/note`
    });
    expect(initialState).toEqual({ ok: true, found: true, value: "hello" });

    const setResult = await authority.router.pathSet({
      authorityClientId: authority.clientId,
      path: `/panes/${paneId}/scratchpad/note`,
      value: "updated"
    });
    expect(setResult).toEqual({ ok: true, value: "updated" });

    const afterSet = await authority.router.pathGet({
      authorityClientId: authority.clientId,
      path: `/panes/${paneId}/scratchpad/note`
    });
    expect(afterSet).toEqual({ ok: true, found: true, value: "updated" });

    const status = await authority.router.pathGet({
      authorityClientId: authority.clientId,
      path: `/status/panes/${paneId}/scratchpad/noteLength`
    });
    expect(status).toEqual({ ok: true, found: true, value: 7 });
  });

  it("rejects /panes/new for pane kinds not declared by any built-in or extension", async () => {
    const clientRegistry = new ClientRegistry();
    const terminalService = createTerminalService(createInMemoryTerminalBackend());
    const authority = await createWebModeShellAuthority({
      projectDir: "/flmux-test",
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry
    });

    await authority.start("http://127.0.0.1:4323");

    const result = (await authority.router.pathCall({
      authorityClientId: authority.clientId,
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
