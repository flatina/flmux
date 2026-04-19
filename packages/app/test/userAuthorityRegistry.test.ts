import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { createInMemoryTerminalBackend, createTerminalService } from "../src/main/terminal-service";
import { createWebModeUserAuthorityRegistry } from "../src/main/userAuthorityRegistry";

const PROJECT_DIR = resolve(import.meta.dir, "..", "..", "..");

describe("web-mode user authority registry (B2 Phase 1)", () => {
  function makeRegistry() {
    return createWebModeUserAuthorityRegistry({
      projectDir: PROJECT_DIR,
      terminalService: createTerminalService(createInMemoryTerminalBackend()),
      clientRegistry: new FlmuxClientRegistry(),
      getOrigin: () => "http://127.0.0.1:4321"
    });
  }

  it("lazily mints a distinct ShellCore per userId and dedupes concurrent bootstrap", async () => {
    const registry = makeRegistry();

    const [alpha1, alpha2] = await Promise.all([
      registry.getOrCreate("alpha"),
      registry.getOrCreate("alpha")
    ]);
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
      clientId: alpha.clientId,
      path: "/workspaces/new"
    });

    const alphaWorkspaces = await alpha.router.pathGet({
      clientId: alpha.clientId,
      path: "/workspaces"
    }) as { ok: true; found: true; value: Record<string, unknown> };
    const betaWorkspaces = await beta.router.pathGet({
      clientId: beta.clientId,
      path: "/workspaces"
    }) as { ok: true; found: true; value: Record<string, unknown> };

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
    await expect(beta.router.pathGet({
      clientId: alpha.clientId,
      path: "/status/app"
    })).rejects.toThrow(`Unknown flmux client: ${alpha.clientId}`);
  });

  it("emits scope=attachment events to the slot targeted by the mutation, not cross-user", async () => {
    const registry = makeRegistry();

    const alpha = await registry.getOrCreate("alpha");
    const beta = await registry.getOrCreate("beta");

    const alphaEvents: string[] = [];
    const betaEvents: string[] = [];
    alpha.subscribe((event) => alphaEvents.push(`${event.topic}:${event.targetAttachmentId ?? "*"}`));
    beta.subscribe((event) => betaEvents.push(`${event.topic}:${event.targetAttachmentId ?? "*"}`));

    // Bootstrap alpha's attachment "alpha_view" — this seeds its slot and
    // emits workspace.activeChanged targeted at that slot.
    alpha.shellBootstrap("alpha_view");

    expect(alphaEvents.some((entry) => entry === "workspace.activeChanged:alpha_view")).toBe(true);
    // Beta's stream must not see alpha's slot-scoped event — each
    // authority's subscribe is local to that user's ShellCore.
    expect(betaEvents.some((entry) => entry.startsWith("workspace.activeChanged:alpha_view"))).toBe(false);
  });
});
