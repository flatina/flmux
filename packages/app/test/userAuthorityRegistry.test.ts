import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientRegistry } from "../src/main/clientRegistry";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import { createWebModeUserAuthorityRegistry } from "../src/main/userAuthorityRegistry";

const PROJECT_DIR = resolve(import.meta.dir, "..", "..", "..");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("web-mode user authority registry (B2 Phase 1)", () => {
  function makeRegistry(options: { sessionsDir?: string } = {}) {
    return createWebModeUserAuthorityRegistry({
      projectDir: PROJECT_DIR,
      terminalService: createTerminalService(createInMemoryTerminalBackend()),
      clientRegistry: new ClientRegistry(),
      getOrigin: () => "http://127.0.0.1:4321",
      ...options
    });
  }

  it("lazily mints a distinct ShellCore per userId and dedupes concurrent bootstrap", async () => {
    const registry = makeRegistry();

    const [alpha1, alpha2] = await Promise.all([registry.getOrCreate("alpha"), registry.getOrCreate("alpha")]);
    expect(alpha1).toBe(alpha2);

    const beta = await registry.getOrCreate("beta");
    expect(beta).not.toBe(alpha1);
    expect(beta.clientId).not.toBe(alpha1.clientId);
  });

  it("isolates workspace mutations between users", async () => {
    const registry = makeRegistry();

    const alpha = await registry.getOrCreate("alpha");
    const beta = await registry.getOrCreate("beta");

    // alpha creates an extra workspace; beta sees only its own default seed.
    await alpha.router.pathCall({
      authorityClientId: alpha.clientId,
      path: "/workspaces/new"
    });

    const alphaWorkspaces = (await alpha.router.pathGet({
      authorityClientId: alpha.clientId,
      path: "/workspaces"
    })) as { ok: true; found: true; value: Record<string, unknown> };
    const betaWorkspaces = (await beta.router.pathGet({
      authorityClientId: beta.clientId,
      path: "/workspaces"
    })) as { ok: true; found: true; value: Record<string, unknown> };

    expect(Object.keys(alphaWorkspaces.value)).toHaveLength(2);
    expect(Object.keys(betaWorkspaces.value)).toHaveLength(1);
  });

  it("rejects cross-user router access via clientId assertion", async () => {
    const registry = makeRegistry();

    const alpha = await registry.getOrCreate("alpha");
    const beta = await registry.getOrCreate("beta");

    // alpha's clientId can't call into beta's router — each router pins
    // its own authority clientId, so leaking alpha's id to beta's route
    // fails closed.
    await expect(
      beta.router.pathGet({
        authorityClientId: alpha.clientId,
        path: "/status/app"
      })
    ).rejects.toThrow(`Unknown flmux client: ${alpha.clientId}`);
  });

  it("emits scope=client events to the slot targeted by the mutation, not cross-user", async () => {
    const registry = makeRegistry();

    const alpha = await registry.getOrCreate("alpha");
    const beta = await registry.getOrCreate("beta");

    const alphaEvents: string[] = [];
    const betaEvents: string[] = [];
    alpha.subscribe((event) => alphaEvents.push(`${event.topic}:${event.targetClientId ?? "*"}`));
    beta.subscribe((event) => betaEvents.push(`${event.topic}:${event.targetClientId ?? "*"}`));

    // Bootstrap alpha's client "alpha_view" — this seeds its slot and
    // emits workspace.activeChanged targeted at that slot.
    alpha.shellBootstrap("alpha_view");

    expect(alphaEvents.some((entry) => entry === "workspace.activeChanged:alpha_view")).toBe(true);
    // Beta's stream must not see alpha's slot-scoped event — each
    // authority's subscribe is local to that user's ShellCore.
    expect(betaEvents.some((entry) => entry.startsWith("workspace.activeChanged:alpha_view"))).toBe(false);
  });

  it("wires per-user session stores under sessionsDir — B2 Phase 2 persistence", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "flmux-sessions-"));
    tempDirs.push(sessionsDir);

    const registry = makeRegistry({ sessionsDir });

    const alpha = await registry.getOrCreate("alpha");
    expect(alpha.persistSession).toBeDefined();
    const createRes = (await alpha.router.pathCall({
      authorityClientId: alpha.clientId,
      path: "/workspaces/new"
    })) as { ok: true; value: { workspaceId: string } };
    const newWorkspaceId = createRes.value.workspaceId;
    // Simulate the renderer layout push — composeSessionSnapshot only
    // persists workspaces present in outerLayout.panels.
    const alphaLayout = {
      outerLayout: {
        panels: {
          "workspace.1": { id: "workspace.1", contentComponent: "workspace" },
          [newWorkspaceId]: { id: newWorkspaceId, contentComponent: "workspace" }
        }
      },
      innerLayouts: {}
    };
    await alpha.persistSession!(alphaLayout);

    const beta = await registry.getOrCreate("beta");
    await beta.persistSession!({
      outerLayout: {
        panels: {
          "workspace.1": { id: "workspace.1", contentComponent: "workspace" }
        }
      },
      innerLayouts: {}
    });

    const userDirs = await readdir(sessionsDir);
    expect(userDirs.sort()).toEqual(["alpha", "beta"]);
    const alphaSnapshot = JSON.parse(await readFile(join(sessionsDir, "alpha", "session.json"), "utf8")) as {
      version: number;
      workspaces: Record<string, unknown>;
    };
    expect(alphaSnapshot.version).toBe(4);
    // alpha created an extra workspace — persisted; beta did not.
    expect(Object.keys(alphaSnapshot.workspaces)).toHaveLength(2);
    const betaSnapshot = JSON.parse(await readFile(join(sessionsDir, "beta", "session.json"), "utf8")) as {
      workspaces: Record<string, unknown>;
    };
    expect(Object.keys(betaSnapshot.workspaces)).toHaveLength(1);
  });

  it("omits persistSession when sessionsDir is not configured", async () => {
    const registry = makeRegistry();
    const alpha = await registry.getOrCreate("alpha");
    expect(alpha.persistSession).toBeUndefined();
  });

  it("evict(userId) runs onAuthorityEvicted and removes the authority", async () => {
    const evictions: Array<{ userId: string; clientId: string }> = [];
    const registry = createWebModeUserAuthorityRegistry({
      projectDir: PROJECT_DIR,
      terminalService: createTerminalService(createInMemoryTerminalBackend()),
      clientRegistry: new ClientRegistry(),
      getOrigin: () => "http://127.0.0.1:4321",
      onAuthorityEvicted: (userId, authority) => {
        evictions.push({ userId, clientId: authority.clientId });
      }
    });

    const alpha = await registry.getOrCreate("alpha");
    const evicted = registry.evict("alpha");
    expect(evicted).toBe(alpha);
    expect(registry.get("alpha")).toBeUndefined();
    expect(evictions).toEqual([{ userId: "alpha", clientId: alpha.clientId }]);

    // Second evict is a no-op; onAuthorityEvicted fires exactly once.
    expect(registry.evict("alpha")).toBeUndefined();
    expect(evictions).toHaveLength(1);
  });

  it("restores persisted workspaces on a fresh registry (restart scenario)", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "flmux-sessions-restore-"));
    tempDirs.push(sessionsDir);

    // Session 1 — alpha creates a second workspace and persists.
    const registry1 = makeRegistry({ sessionsDir });
    const alpha1 = await registry1.getOrCreate("alpha");
    const createRes = (await alpha1.router.pathCall({
      authorityClientId: alpha1.clientId,
      path: "/workspaces/new"
    })) as { ok: true; value: { workspaceId: string } };
    await alpha1.persistSession!({
      outerLayout: {
        panels: {
          "workspace.1": { id: "workspace.1", contentComponent: "workspace" },
          [createRes.value.workspaceId]: { id: createRes.value.workspaceId, contentComponent: "workspace" }
        }
      },
      innerLayouts: {}
    });

    // Session 2 — fresh registry, same sessionsDir. Alpha's authority
    // should restore the two workspaces from disk instead of seeding one.
    const registry2 = makeRegistry({ sessionsDir });
    const alpha2 = await registry2.getOrCreate("alpha");
    const workspaces = (await alpha2.router.pathGet({
      authorityClientId: alpha2.clientId,
      path: "/workspaces"
    })) as { ok: true; found: true; value: Record<string, unknown> };
    expect(Object.keys(workspaces.value).sort()).toEqual(["workspace.1", createRes.value.workspaceId].sort());

    // The restored authority also exposes the layout via shellBootstrap
    // so browser clients get the saved outer/inner layouts.
    const bootstrap = alpha2.shellBootstrap("alpha_view");
    expect(bootstrap.outerLayout).not.toBeNull();
  });
});
