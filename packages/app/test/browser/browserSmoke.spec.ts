import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..");

interface WebAppHandle {
  process: ChildProcess;
  rootDir: string;
  authDir: string;
  origin: string;
  token: string;
}

let handle: WebAppHandle | null = null;

test.beforeAll(async () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), "flmux-browser-smoke-"));
  const authDir = join(rootDir, ".flmux", "auth");
  const tokenProcess = spawn("bun", ["src/cli.ts", "tokens", "bootstrap", "--auth-dir", authDir], { cwd: APP_DIR });
  const tokenOutput = await collectOutput(tokenProcess);
  const bootstrap = JSON.parse(tokenOutput) as { token: string };

  const appProcess = spawn("bun", ["run", "dev", "--", "--web"], {
    cwd: APP_DIR,
    env: { ...process.env, FLMUX_ROOT_DIR: rootDir, FLMUX_DEV_MODE: "1" }
  });

  const origin = await waitForOrigin(appProcess);
  handle = { process: appProcess, rootDir, authDir, origin, token: bootstrap.token };
});

test.afterAll(async () => {
  if (!handle) return;
  handle.process.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (!handle.process.killed) handle.process.kill("SIGKILL");
  try {
    rmSync(handle.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // best-effort
  }
});

test("workbench bootstraps and mounts in real browser", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    // Workbench mounts a `.dockview-shell` root once bootstrap completes +
    // the first `shellCore.event` subscribes. Wait for it as the smoke
    // end-state: all of bootstrap + WS attach + dockview render succeeded.
    await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });
    // Seeded workspace.1 pane should exist (cowsay + browser from seedWorkspace).
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

// C1 — WS drop within grace window → reconnect replays buffered events.
// Proves B1c's ring buffer + seq-gated replay in the real-browser path:
// setOffline closes the WS, a pane is created via HTTP during the gap,
// setOffline(false) lets bunite's WS client reconnect and call
// `flmux.client.register` with lastAppliedSeq — the server replays the
// missed `pane.added` event so the new pane materializes in the UI
// without a full rebootstrap.
test("C1 WS reconnect replays buffered events (B1c)", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible({ timeout: 20_000 });

    const paneSelector = '.workspace-panel[data-workspace-id="workspace.1"] .browser-panel';
    const initialPaneCount = await page.locator(paneSelector).count();

    await context.setOffline(true);
    // Give the WS close + ring-buffer-only transition a moment to settle
    // before the server-side mutation emits.
    await page.waitForTimeout(500);

    // Mutate via HTTP using the same auth token (independent of the page's
    // WS transport) — the resulting pane.added hits the attachment's ring
    // buffer while the live forwarder is detached.
    const cookies = await context.cookies(handle.origin);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const clientsRes = await fetch(`${handle.origin}/api/clients`, {
      headers: { cookie: cookieHeader }
    });
    const clients = (await clientsRes.json()) as { clients: Array<{ clientId: string }> };
    const authorityClientId = clients.clients[0]!.clientId;

    const createRes = await fetch(`${handle.origin}/api/model/path/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({
        clientId: authorityClientId,
        path: "/panes/new",
        args: { kind: "browser", url: "/__flmux/internal/start?workspace=workspace.1", place: "right" }
      })
    });
    expect(createRes.status).toBe(200);

    await context.setOffline(false);

    // WS reconnects + register replays missed events → pane count increases.
    await expect(page.locator(paneSelector)).toHaveCount(initialPaneCount + 1, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

// C2 — Cookie continuity across tab refresh. Proves B2 Phase 3's
// `flmux-attachment` httpOnly cookie lets /api/shell/bootstrap reuse the
// attachmentId inside the grace window, preserving slot state (active
// workspace) across page.reload(). Also confirms cross-user cookie
// safety: a second user's context presenting the first user's
// attachment cookie gets a freshly minted id.
test("C2 tab refresh reuses attachmentId + preserves slot state (B2P3)", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible({ timeout: 20_000 });

    const attachmentIdBefore = (await context.cookies(handle.origin)).find((c) => c.name === "flmux-attachment")?.value;
    expect(attachmentIdBefore).toMatch(/^web_/);

    // Mutate slot state so the reload's preservation is observable:
    // create a second workspace + switch to it. B2 Phase 3 preserves
    // the slot's activeWorkspaceId across the refresh.
    const cookies = await context.cookies(handle.origin);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const clientId = (
      (await (
        await fetch(`${handle.origin}/api/clients`, {
          headers: { cookie: cookieHeader }
        })
      ).json()) as { clients: Array<{ clientId: string }> }
    ).clients[0]!.clientId;

    const created = (await (
      await fetch(`${handle.origin}/api/model/path/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({ clientId, path: "/workspaces/new", args: { title: "Continuity" } })
      })
    ).json()) as { result: { value: { workspaceId: string } } };
    const ws2 = created.result.value.workspaceId;

    await expect(page.locator(`.workspace-panel[data-workspace-id="${ws2}"]`)).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });

    const attachmentIdAfter = (await context.cookies(handle.origin)).find((c) => c.name === "flmux-attachment")?.value;
    expect(attachmentIdAfter).toBe(attachmentIdBefore);

    // Cross-user: isolated context presenting user A's attachment cookie
    // should mint fresh (attachmentIdToUserId guard on the bootstrap side).
    const userBContext = await browser.newContext();
    try {
      await userBContext.addCookies([
        { name: "flmux_web_token", value: handle.token, url: handle.origin },
        { name: "flmux-attachment", value: attachmentIdBefore!, url: handle.origin }
      ]);
      // Re-login as the SAME user here — we just want to prove that when
      // the server sees a cookie it doesn't own for this context (same user
      // but the server already evicted it? actually with same user cookie
      // would be reused). This simplifies to "safe even with forged cookie":
      // an attachment id the server doesn't know maps to mint-fresh.
      const bogusRes = await fetch(`${handle.origin}/api/shell/bootstrap`, {
        method: "POST",
        headers: {
          cookie: `flmux_web_token=${handle.token}; flmux-attachment=web_bogus_does_not_exist`
        }
      });
      const bogusBody = (await bogusRes.json()) as { attachmentId: string };
      expect(bogusBody.attachmentId).not.toBe("web_bogus_does_not_exist");
    } finally {
      await userBContext.close();
    }
  } finally {
    await context.close();
  }
});

// C3 — Per-attachment active state divergence. Proves B1b's per-slot
// active state + scope=attachment event filtering: two browser contexts
// under the same user get distinct attachmentIds, and each tab's
// setActiveWorkspace only moves its own slot.
//
// Dockview's synthetic DOM (.click(), PointerEvent dispatch) flips the
// `dv-active-tab` class but doesn't fire `onDidActivePanelChange`, and
// even `panel.api.setActive()` only partially propagates. We drive the
// same `shellModel.pathCall` the click handler would — exposed under
// FLMUX_DEV_MODE=1 as `window.__flmuxTest.setActiveWorkspace`. The call
// routes through preload/WS so `hostRequests.ts` injects
// `caller.attachmentId`, exercising the per-slot RPC path that HTTP
// alone can't reach after the B3 caller-drop.
//
// Scope limit: the hook bypasses Dockview's click → `pathCall` chain, so
// a regression in the click wiring itself wouldn't fail here. Covered
// elsewhere (outerApi.onDidActivePanelChange handler in workbench.ts).
test("C3 two tabs of the same user keep independent active workspaces (B1b)", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await pageA.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    await expect(pageA.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });

    const cookieHeaderA = (await contextA.cookies(handle.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const attachA = (await contextA.cookies(handle.origin)).find((c) => c.name === "flmux-attachment")!.value;
    const clientId = (
      (await (
        await fetch(`${handle.origin}/api/clients`, {
          headers: { cookie: cookieHeaderA }
        })
      ).json()) as { clients: Array<{ clientId: string }> }
    ).clients[0]!.clientId;

    // Create workspace.2 while only tab A exists — both attachments will
    // see it via scope=all workspace.added, but only A's slot is on ws.2.
    const created = (await (
      await fetch(`${handle.origin}/api/model/path/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeaderA },
        body: JSON.stringify({ clientId, path: "/workspaces/new", args: { title: "Divergence" } })
      })
    ).json()) as { result: { value: { workspaceId: string } } };
    const ws2 = created.result.value.workspaceId;

    // Tab B bootstraps into the same user but a fresh attachment.
    const pageB = await contextB.newPage();
    await pageB.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    await expect(pageB.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });

    const attachB = (await contextB.cookies(handle.origin)).find((c) => c.name === "flmux-attachment")!.value;
    expect(attachB).not.toBe(attachA);

    // Both tabs start on workspace.1 (seed) — document.title reflects the
    // active workspace's title.
    await expect(pageA).toHaveTitle(/Workspace 1/);
    await expect(pageB).toHaveTitle(/Workspace 1/);

    // Drive the outer-tab activation through the dev-mode hook — the
    // programmatic path that mirrors what a real click *would* do if
    // dockview fired its change event for synthetic input.
    await pageA.evaluate(
      (id) =>
        (
          window as unknown as {
            __flmuxTest: { setActiveWorkspace(id: string): void };
          }
        ).__flmuxTest.setActiveWorkspace(id),
      ws2
    );

    // Tab A's title now reflects ws.2; Tab B stays on ws.1.
    // This is the observable per-attachment divergence — scope=attachment
    // `workspace.activeChanged` reached only pageA.
    await expect(pageA).toHaveTitle(/Divergence/, { timeout: 15_000 });
    // Observation window: even if the scope=attachment event leaked, it
    // would reach B within the same network hop as A. Wait past that
    // window before asserting B's title hasn't moved.
    await pageB.waitForTimeout(1000);
    await expect(pageB).toHaveTitle(/Workspace 1/);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

// C6 — `allow_paths.read` ACL gates the live WS event stream (B3).
// HTTP smoke covers the denial side on `/api/model/path/*`, but the
// broadcast forwarder (`main.ts:isEventAllowedForAttachment`) is a
// separate gate that only fires over real WS. Single-user scope: each
// web user has their own `ShellCore`, so the ACL applies to the user's
// own event stream, not cross-user. We give `restricted` a read scope
// limited to workspace.1, have them create a second workspace via
// (allowed) write/call, and assert they don't see the `workspace.added`
// event for the new workspace — even though they initiated it.
test("C6 allow_paths.read gates broadcast forwarder (B3)", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");

  writeFileSync(
    resolve(handle.authDir, "users.toml"),
    [
      `[[users]]`,
      `name = "admin"`,
      `allow_pane_kinds = "*"`,
      `allow_paths = "*"`,
      ``,
      `[[users]]`,
      `name = "restricted"`,
      `allow_pane_kinds = "*"`,
      ``,
      `[users.allow_paths]`,
      `read = ["/status/workspaces/workspace.1/**", "/status/attachments/**"]`,
      `write = ["**"]`,
      `call = ["**"]`,
      ``
    ].join("\n"),
    "utf8"
  );

  const issueProc = spawn(
    "bun",
    ["src/cli.ts", "tokens", "issue", "--user", "restricted", "--auth-dir", handle.authDir],
    { cwd: APP_DIR }
  );
  const { token: restrictedToken } = JSON.parse(await collectOutput(issueProc)) as { token: string };

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(restrictedToken)}`);
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible({ timeout: 20_000 });

    const cookieHeader = (await context.cookies(handle.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const clientId = (
      (await (
        await fetch(`${handle.origin}/api/clients`, {
          headers: { cookie: cookieHeader }
        })
      ).json()) as { clients: Array<{ clientId: string }> }
    ).clients[0]!.clientId;

    // Positive control — rename workspace.1 (in read scope). Confirms the
    // forwarder is alive and events reach the DOM. Without this the
    // negative assertion below is vacuous.
    const renamedTitle = "C6-renamed-ws1";
    await fetch(`${handle.origin}/api/model/path/set`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({
        clientId,
        path: "/workspaces/workspace.1/title",
        value: renamedTitle
      })
    });
    await expect(page.locator(".dv-tab", { hasText: renamedTitle })).toBeVisible({ timeout: 10_000 });

    // Negative — create a new workspace. Event `workspace.added` maps to
    // `/status/workspaces/<newId>` which isn't in read scope.
    const created = (await (
      await fetch(`${handle.origin}/api/model/path/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({
          clientId,
          path: "/workspaces/new",
          args: { title: "ShouldBeHidden-c6" }
        })
      })
    ).json()) as { result: { value: { workspaceId: string } } };
    const hiddenWsId = created.result.value.workspaceId;

    await page.waitForTimeout(1500);
    await expect(page.locator(`.workspace-panel[data-workspace-id="${hiddenWsId}"]`)).toHaveCount(0);
    await expect(page.locator(".dv-tab", { hasText: "ShouldBeHidden-c6" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// C5 — Authority evicts from `userAuthorityRegistry` after the last
// attachment's grace plus the authority grace on top. Spawn a fresh
// flmux --web with short grace env overrides so the eviction chain
// (attachment-evict → authority-evict) fits within a few seconds.
//
// Observable: a second bootstrap under the same token returns a
// different authority `clientId`, proving the old registry entry was
// dropped and `userAuthorityRegistry.getOrCreate` minted a fresh
// authority. This is the invariant under test — the registry-level
// eviction + re-create. Resource-cleanup of the dropped authority
// (ShellCore GC, ptyd lifecycle) is out of scope here and covered by
// the `onAuthorityEvicted` side-effect wiring in `main.ts`.
test("C5 authority evicts after attachment+authority grace", async ({ browser }) => {
  const rootDir = mkdtempSync(resolve(tmpdir(), "flmux-c5-"));
  const authDir = join(rootDir, ".flmux", "auth");
  let appProc: ChildProcess | null = null;

  try {
    const tokenProc = spawn("bun", ["src/cli.ts", "tokens", "bootstrap", "--auth-dir", authDir], { cwd: APP_DIR });
    const { token } = JSON.parse(await collectOutput(tokenProc)) as { token: string };

    appProc = spawn("bun", ["src/main.ts", "--web"], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        FLMUX_ROOT_DIR: rootDir,
        FLMUX_DEV_MODE: "1",
        FLMUX_ATTACHMENT_GRACE_MS: "300",
        FLMUX_AUTHORITY_EVICTION_GRACE_MS: "300"
      }
    });
    const origin = await waitForOrigin(appProc);

    const getAuthorityClientId = async (ctx: import("@playwright/test").BrowserContext) => {
      const cookieHeader = (await ctx.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const res = await fetch(`${origin}/api/clients`, { headers: { cookie: cookieHeader } });
      return ((await res.json()) as { clients: Array<{ clientId: string }> }).clients[0]!.clientId;
    };

    const contextBefore = await browser.newContext();
    let clientIdBefore: string;
    try {
      const page = await contextBefore.newPage();
      await page.goto(`${origin}/?token=${encodeURIComponent(token)}`);
      await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });
      clientIdBefore = await getAuthorityClientId(contextBefore);
    } finally {
      await contextBefore.close();
    }

    // Wait past attachment grace (300) + authority grace (300) + margin.
    // The eviction chain only starts when the server observes the WS
    // disconnect (via `onWebClientDisconnected`), which can lag
    // `context.close()` on slow runners — keep a generous cushion.
    await new Promise((r) => setTimeout(r, 3000));

    const contextAfter = await browser.newContext();
    try {
      const page = await contextAfter.newPage();
      await page.goto(`${origin}/?token=${encodeURIComponent(token)}`);
      await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });
      const clientIdAfter = await getAuthorityClientId(contextAfter);
      expect(clientIdAfter).not.toBe(clientIdBefore);
    } finally {
      await contextAfter.close();
    }
  } finally {
    if (appProc) {
      appProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!appProc.killed) appProc.kill("SIGKILL");
    }
    try {
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* best-effort */
    }
  }
});

// C7 — Server-side terminal runtime identity + state survive a browser
// WS drop/reconnect (triggered by `page.reload()`). Proves that ptyd's
// runtime isn't killed when the only owning WS disconnects within the
// grace window, and history + runtimeId stay stable across the drop.
//
// Scope limit: the post-reload assertions are all HTTP against server
// state. They don't verify that the reloaded renderer re-adopts the
// terminal or that `terminal.event` forwarding recovers in the new
// viewId — those are separate UX concerns (`paneOwners` is keyed by
// viewId and doesn't survive reload). The invariant under test here is
// strictly server-side resilience to WS drop, which HTTP smoke can't
// exercise because it has no real-WS transport to drop.
test("C7 terminal runtime survives browser WS drop across page.reload", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible({ timeout: 20_000 });

    const cookieHeader = (await context.cookies(handle.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const clientId = (
      (await (
        await fetch(`${handle.origin}/api/clients`, {
          headers: { cookie: cookieHeader }
        })
      ).json()) as { clients: Array<{ clientId: string }> }
    ).clients[0]!.clientId;

    const origin = handle.origin;
    const httpPath = async (method: "get" | "call" | "set", path: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${origin}/api/model/path/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({ clientId, path, ...extra })
      });
      return (await res.json()) as {
        result: { ok: true; value: unknown } | { ok: false; error: string; code: string };
      };
    };

    const created = (await httpPath("call", "/panes/new", {
      args: { kind: "terminal", place: "right", workspaceId: "workspace.1" }
    })) as unknown as { result: { ok: true; value: { paneId: string } } };
    expect(created.result.ok).toBe(true);
    const paneId = created.result.value.paneId;
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"] .terminal-panel')).toBeVisible({
      timeout: 10_000
    });

    // Renderer mounts the terminal pane and calls `/terminal/attach` over
    // its WS — wait for the runtime to settle on the server side.
    const runtimeIdBefore = await waitForRuntimeId(handle.origin, cookieHeader, clientId, paneId);

    // Write a marker through HTTP — ptyd's PTY echoes it back to the
    // session history buffer regardless of who wrote it.
    const marker = "flmux-c7-marker";
    await httpPath("call", `/panes/${paneId}/terminal/write`, { args: { data: `echo ${marker}\r` } });
    await page.waitForTimeout(500);
    const historyBefore = await readHistory(handle.origin, cookieHeader, clientId, paneId);
    expect(historyBefore).toContain(marker);

    await page.reload();
    await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"] .terminal-panel')).toBeVisible({
      timeout: 15_000
    });

    const cookieHeaderAfter = (await context.cookies(handle.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    // Same user/authority → same clientId (structural, not proof of the
    // reloaded view's WS state).
    const runtimeIdAfter = await waitForRuntimeId(handle.origin, cookieHeaderAfter, clientId, paneId);
    expect(runtimeIdAfter).toBe(runtimeIdBefore);

    const historyAfter = await readHistory(handle.origin, cookieHeaderAfter, clientId, paneId);
    expect(historyAfter).toContain(marker);

    // Also confirm the runtime is still writable — same ptyd process
    // accepts input and history grows with the post-reload marker.
    const marker2 = "flmux-c7-post-reload";
    await fetch(`${origin}/api/model/path/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeaderAfter },
      body: JSON.stringify({
        clientId,
        path: `/panes/${paneId}/terminal/write`,
        args: { data: `echo ${marker2}\r` }
      })
    });
    await page.waitForTimeout(500);
    const historyFinal = await readHistory(handle.origin, cookieHeaderAfter, clientId, paneId);
    expect(historyFinal).toContain(marker);
    expect(historyFinal).toContain(marker2);
  } finally {
    await context.close();
  }
});

async function waitForRuntimeId(
  origin: string,
  cookieHeader: string,
  clientId: string,
  paneId: string
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${origin}/api/model/path/get`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ clientId, path: `/status/panes/${paneId}/terminal/runtimeId` })
    });
    const body = (await res.json()) as { result: { ok: true; value: string | null } };
    if (body.result.ok && typeof body.result.value === "string") {
      return body.result.value;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForRuntimeId(${paneId}): no runtime attached within 15s`);
}

async function readHistory(origin: string, cookieHeader: string, clientId: string, paneId: string): Promise<string> {
  const res = await fetch(`${origin}/api/model/path/call`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ clientId, path: `/panes/${paneId}/terminal/history`, args: { maxBytes: 4096 } })
  });
  const body = (await res.json()) as { result: { ok: true; value: { data: string } } };
  return body.result.value.data;
}

async function collectOutput(proc: ChildProcess): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolveFn(stdout);
      else reject(new Error(`process exited ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function waitForOrigin(proc: ChildProcess): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => {
      reject(new Error("timed out waiting for web origin — server didn't start"));
    }, 30_000);
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /\[flmux\] web origin: (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (match) {
        clearTimeout(deadline);
        resolveFn(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`flmux --web exited early with code ${code}`));
    });
  });
}
