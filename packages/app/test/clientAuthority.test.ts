import { describe, expect, it } from "bun:test";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { createShellModelRouter } from "../src/main/shellModelBridge";
import { startFlmuxServer, type FlmuxServerHandle } from "../src/main/server";
import type { ShellModelAPI } from "../src/renderer/shell/types";
import type { RendererShellModelBridge } from "../src/shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../src/shared/terminal";
import { TestShellModelHost } from "./support/testShellModelHost";

function createLocalBridge(
  shellModel: ShellModelAPI,
  onTerminalEvent?: (event: TerminalRuntimeEvent) => void
): RendererShellModelBridge {
  return {
    setTransport() {},
    requestProxy: {
      "shellModel.path.get": (params: unknown) => shellModel.pathGet((params as { path: string }).path),
      "shellModel.path.list": (params: unknown) => shellModel.pathList((params as { path: string }).path),
      "shellModel.path.set": (params: unknown) => {
        const input = params as { path: string; value: unknown };
        return shellModel.pathSet(input.path, input.value);
      },
      "shellModel.path.call": (params: unknown) => {
        const input = params as { path: string; args?: Record<string, unknown> };
        return shellModel.pathCall(input.path, input.args);
      }
    } as RendererShellModelBridge["requestProxy"],
    sendProxy: {
      "terminal.event": (payload) => onTerminalEvent?.(payload)
    }
  };
}

async function postJson<T>(origin: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json() as Promise<T>;
}

describe("Phase 2: client-scoped authority boundary", () => {
  it("two concurrent clients own independent workspace trees", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const hostA = new TestShellModelHost({
      workspaceId: "workspace.alpha",
      workspaceTitle: "Workspace Alpha",
      activePaneId: null,
      panes: []
    });
    const hostB = new TestShellModelHost({
      workspaceId: "workspace.beta",
      workspaceTitle: "Workspace Beta",
      activePaneId: null,
      panes: []
    });

    const bridgeA = createLocalBridge(hostA.createModel());
    const bridgeB = createLocalBridge(hostB.createModel());

    registry.attachRenderer(1, bridgeA);
    registry.attachRenderer(2, bridgeB);
    const { clientId: clientA } = router.registerClient(1);
    const { clientId: clientB } = router.registerClient(2);

    expect(clientA).not.toBe(clientB);

    // Client A creates a cowsay pane
    await router.pathCall({ clientId: clientA, path: "/panes/new", args: { kind: "cowsay" } });

    // Client B creates a terminal pane
    await router.pathCall({ clientId: clientB, path: "/panes/new", args: { kind: "terminal", cwd: "." } });

    // Each client only sees its own panes
    const panesA = await router.pathList({ clientId: clientA, path: "/panes" }) as {
      ok: boolean;
      found: boolean;
      entries: Array<{ name: string }>;
    };
    const panesB = await router.pathList({ clientId: clientB, path: "/panes" }) as {
      ok: boolean;
      found: boolean;
      entries: Array<{ name: string }>;
    };

    expect(panesA.ok).toBe(true);
    expect(panesB.ok).toBe(true);
    expect(panesA.entries).toHaveLength(1);
    expect(panesB.entries).toHaveLength(1);
    expect(panesA.entries[0].name).not.toBe(panesB.entries[0].name);

    // Workspace titles are independent
    const wsA = await router.pathGet({ clientId: clientA, path: "/status/workspace" }) as {
      ok: boolean;
      found: boolean;
      value: { id: string; title: string };
    };
    const wsB = await router.pathGet({ clientId: clientB, path: "/status/workspace" }) as {
      ok: boolean;
      found: boolean;
      value: { id: string; title: string };
    };

    expect(wsA.value.id).toBe("workspace.alpha");
    expect(wsB.value.id).toBe("workspace.beta");
  });

  it("clientB cannot see clientA's panes through cross-client path", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const hostA = new TestShellModelHost({
      workspaceId: "workspace.alpha",
      activePaneId: null,
      panes: [
        { id: "pane.secret", kind: "cowsay", title: "Secret Cowsay" }
      ]
    });
    const hostB = new TestShellModelHost({
      workspaceId: "workspace.beta",
      activePaneId: null,
      panes: []
    });

    registry.attachRenderer(1, createLocalBridge(hostA.createModel()));
    registry.attachRenderer(2, createLocalBridge(hostB.createModel()));
    const { clientId: clientA } = router.registerClient(1);
    const { clientId: clientB } = router.registerClient(2);

    // Client A can see its own pane
    const resultA = await router.pathGet({ clientId: clientA, path: "/panes/pane.secret" }) as {
      ok: boolean;
      found: boolean;
    };
    expect(resultA.ok).toBe(true);
    expect(resultA.found).toBe(true);

    // Client B cannot see Client A's pane — each client's shell model is isolated
    const resultB = await router.pathGet({ clientId: clientB, path: "/panes/pane.secret" }) as {
      ok: boolean;
      found: boolean;
    };
    expect(resultB.ok).toBe(true);
    expect(resultB.found).toBe(false);
  });

  it("rejects unknown clientId with error", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    expect(() =>
      router.pathGet({ clientId: "client_nonexistent", path: "/title" })
    ).toThrow("Unknown flmux client");
  });

  it("HTTP API returns error for missing clientId", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const server = startFlmuxServer({
      rendererDir: ".",
      shellModelRouter: router
    });

    try {
      const result = await postJson<{ ok: boolean; error: string }>(
        server.origin,
        "/api/model/path/get",
        { path: "/title" }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown flmux client");
    } finally {
      server.stop();
    }
  });

  it("HTTP API returns error for invalid clientId", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const server = startFlmuxServer({
      rendererDir: ".",
      shellModelRouter: router
    });

    try {
      const result = await postJson<{ ok: boolean; error: string }>(
        server.origin,
        "/api/model/path/get",
        { clientId: "client_invalid_uuid", path: "/title" }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown flmux client");
    } finally {
      server.stop();
    }
  });

  it("lists all registered clients with independent workspace status", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const hostA = new TestShellModelHost({
      workspaceId: "workspace.alpha",
      workspaceTitle: "Alpha",
      activePaneId: null,
      panes: []
    });
    const hostB = new TestShellModelHost({
      workspaceId: "workspace.beta",
      workspaceTitle: "Beta",
      activePaneId: null,
      panes: []
    });

    registry.attachRenderer(1, createLocalBridge(hostA.createModel()));
    registry.attachRenderer(2, createLocalBridge(hostB.createModel()));
    router.registerClient(1);
    router.registerClient(2);

    const clients = await router.listClients();
    expect(clients).toHaveLength(2);

    const workspaceIds = clients.map((c) => (c.workspace as { id: string })?.id).sort();
    expect(workspaceIds).toEqual(["workspace.alpha", "workspace.beta"]);
  });

  it("detaching a client removes it without affecting other clients", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const hostA = new TestShellModelHost({ workspaceId: "workspace.alpha" });
    const hostB = new TestShellModelHost({ workspaceId: "workspace.beta" });

    registry.attachRenderer(1, createLocalBridge(hostA.createModel()));
    registry.attachRenderer(2, createLocalBridge(hostB.createModel()));
    const { clientId: clientA } = router.registerClient(1);
    const { clientId: clientB } = router.registerClient(2);

    // Detach client A
    registry.detachRenderer(1);

    // Client A is gone
    expect(() =>
      router.pathGet({ clientId: clientA, path: "/title" })
    ).toThrow("Unknown flmux client");

    // Client B still works
    const result = await router.pathGet({ clientId: clientB, path: "/title" }) as {
      ok: boolean;
      found: boolean;
      value: string;
    };
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
  });

  it("mutating clientA workspace title does not affect clientB", async () => {
    const registry = new FlmuxClientRegistry();
    const router = createShellModelRouter(registry);

    const hostA = new TestShellModelHost({
      workspaceId: "workspace.alpha",
      workspaceTitle: "Alpha"
    });
    const hostB = new TestShellModelHost({
      workspaceId: "workspace.beta",
      workspaceTitle: "Beta"
    });

    registry.attachRenderer(1, createLocalBridge(hostA.createModel()));
    registry.attachRenderer(2, createLocalBridge(hostB.createModel()));
    const { clientId: clientA } = router.registerClient(1);
    const { clientId: clientB } = router.registerClient(2);

    // Mutate A's title
    await router.pathSet({ clientId: clientA, path: "/title", value: "Alpha Renamed" });

    // B's title is untouched
    const titleB = await router.pathGet({ clientId: clientB, path: "/title" }) as {
      ok: boolean;
      found: boolean;
      value: string;
    };
    expect(titleB.value).toBe("Beta");

    // A's title changed
    const titleA = await router.pathGet({ clientId: clientA, path: "/title" }) as {
      ok: boolean;
      found: boolean;
      value: string;
    };
    expect(titleA.value).toBe("Alpha Renamed");
  });
});
