import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import { fetchJson, postJson, waitFor, waitForWebOrigin } from "../support/realAppSmokeSupport";
import { runTokensCli } from "../../src/cliTokens";
import { stringifyUsersToml } from "../../src/main/auth/tomlWriter";

interface WebBootSmokeOptions {
  token: string;
  authDir: string;
}

export async function runWebModeBootSmokeScenario(appHandles: AppProcessHandle[], options: WebBootSmokeOptions) {
  const handle = appHandles[appHandles.length - 1];
  if (!handle) {
    throw new Error("web app handle is required");
  }

  const { origin } = await waitForWebOrigin(handle, "web origin");
  const attachUrl = `${origin}/?token=${encodeURIComponent(options.token)}`;

  const attachResponse = await fetch(attachUrl);
  expect(attachResponse.status).toBe(200);
  const setCookie = attachResponse.headers.get("set-cookie");
  expect(setCookie).toContain(`flmux_web_token=${options.token}`);
  const html = await attachResponse.text();
  expect(html).toContain('id="app"');
  expect(html).toContain("<script");

  const cookieHeader = cookieFromSetCookie(setCookie);
  const assetPath = extractModuleAssetPath(html);
  expect(assetPath).not.toBeNull();
  const assetResponse = await fetch(`${origin}${assetPath}`, {
    headers: { cookie: cookieHeader }
  });
  expect(assetResponse.status).toBe(200);

  const unauthorizedClients = await fetch(`${origin}/api/clients`);
  expect(unauthorizedClients.status).toBe(401);

  // `/api/shell/bootstrap` — browser attach handshake (B1d). Sync body,
  // cookie-minted attachmentId, snapshot with seqStart.
  const shellBootstrapRes = await fetch(`${origin}/api/shell/bootstrap`, {
    method: "POST",
    headers: { cookie: cookieHeader }
  });
  expect(shellBootstrapRes.status).toBe(200);
  const attachmentCookie = shellBootstrapRes.headers.get("set-cookie");
  expect(attachmentCookie).toContain("flmux-attachment=");
  expect(attachmentCookie).toContain("HttpOnly");
  expect(attachmentCookie).toContain("Path=/");
  const shellBootstrap = (await shellBootstrapRes.json()) as {
    attachmentId: string;
    snapshot: { activeWorkspaceId: string | null };
    outerLayout: unknown;
    innerLayouts: Record<string, unknown>;
    seqStart: number;
  };
  expect(shellBootstrap.attachmentId).toMatch(/^web_/);
  expect(shellBootstrap.snapshot.activeWorkspaceId).toBe("workspace.1");
  expect(shellBootstrap.outerLayout).toBeNull();
  expect(typeof shellBootstrap.seqStart).toBe("number");

  // Unauthorized bootstrap POST must be rejected even if the browser
  // forgets the cookie.
  const anonBootstrap = await fetch(`${origin}/api/shell/bootstrap`, { method: "POST" });
  expect(anonBootstrap.status).toBe(401);

  // Cookie continuity (B2 Phase 3): presenting the previous attachment
  // cookie alongside auth reuses the attachmentId. Mint-fresh only when
  // the cookie is absent, mismatched, or the server no longer owns it.
  const continuityRes = await fetch(`${origin}/api/shell/bootstrap`, {
    method: "POST",
    headers: { cookie: `${cookieHeader}; flmux-attachment=${shellBootstrap.attachmentId}` }
  });
  expect(continuityRes.status).toBe(200);
  const continuityBody = (await continuityRes.json()) as { attachmentId: string };
  expect(continuityBody.attachmentId).toBe(shellBootstrap.attachmentId);

  // Bogus cookie → server falls back to minting fresh (isolation preserved).
  const bogusRes = await fetch(`${origin}/api/shell/bootstrap`, {
    method: "POST",
    headers: { cookie: `${cookieHeader}; flmux-attachment=web_unknown` }
  });
  expect(bogusRes.status).toBe(200);
  const bogusBody = (await bogusRes.json()) as { attachmentId: string };
  expect(bogusBody.attachmentId).not.toBe("web_unknown");
  expect(bogusBody.attachmentId).toMatch(/^web_/);

  const clients = await fetchJson<{
    ok: true;
    clients: Array<{
      clientId: string;
      workspace: {
        id: string;
        title: string;
        defaultTitle: string;
        paneCount: number;
      } | null;
    }>;
  }>(`${origin}/api/clients`, {
    headers: { cookie: cookieHeader }
  });
  expect(clients.ok).toBe(true);
  expect(clients.clients).toHaveLength(1);

  const authorityClientId = clients.clients[0].clientId;
  const createdBrowser = await postJson<{
    ok: true;
    result: {
      ok: true;
      value: {
        paneId: string;
        pane: {
          kind: string;
          title: string;
        };
      };
    };
  }>(
    `${origin}/api/model/path/call`,
    {
      clientId: authorityClientId,
      path: "/panes/new",
      args: {
        kind: "browser",
        url: "/__flmux/internal/start?workspace=workspace.1",
        place: "right"
      }
    },
    {
      headers: { cookie: cookieHeader }
    }
  );
  expect(createdBrowser.result.value.pane.kind).toBe("browser");

  const cliCreatedTerminal = await runCliJson([
    "call",
    "/panes/new",
    "kind=terminal",
    "cwd=.",
    "--origin",
    origin,
    "--token",
    options.token
  ]);
  expect(cliCreatedTerminal).toMatchObject({
    ok: true,
    result: {
      ok: true,
      value: {
        pane: {
          kind: "terminal"
        }
      }
    }
  });

  const createdCowsay = await postJson<{
    ok: true;
    result: {
      ok: true;
      value: {
        pane: {
          kind: string;
          title: string;
        };
      };
    };
  }>(
    `${origin}/api/model/path/call`,
    {
      clientId: authorityClientId,
      path: "/panes/new",
      args: { kind: "cowsay" }
    },
    {
      headers: { cookie: cookieHeader }
    }
  );
  expect(createdCowsay.result.value.pane.kind).toBe("cowsay");
  expect(createdCowsay.result.value.pane.title).toBe("Cowsay");

  await waitFor(
    async () => {
      const panes = await postJson<{
        ok: true;
        result: {
          ok: true;
          found: true;
          value: Record<string, { kind: string; title: string }>;
        };
      }>(
        `${origin}/api/model/path/get`,
        {
          clientId: authorityClientId,
          path: "/status/workspaces/workspace.1/panes"
        },
        {
          headers: { cookie: cookieHeader }
        }
      );

      const paneKinds = Object.values(panes.result.value).map((pane) => pane.kind);
      return paneKinds.filter((kind) => kind === "browser").length >= 2 &&
        paneKinds.includes("terminal") &&
        paneKinds.includes("cowsay")
        ? panes.result.value
        : null;
    },
    { timeoutMs: 15_000, intervalMs: 250, label: "web mode pane list after API and CLI calls" }
  );

  // ── Multi-user isolation (B2 Phase 1) ─────────────────────────────
  // Second user's authority is a distinct ShellCore; nothing from admin
  // above leaks into beta's snapshot / clients / pane list. Proves the
  // per-user routing chain (auth → registry → authority) at the HTTP
  // layer end-to-end — complementing `userAuthorityRegistry.test.ts`
  // which covers the factory in isolation.
  writeFileSync(
    join(options.authDir, "users.toml"),
    stringifyUsersToml([
      { name: "admin", allowPaneKinds: "*", allowPaths: "*" },
      { name: "beta", allowPaneKinds: "*", allowPaths: "*" }
    ]),
    "utf8"
  );
  const betaTokenResult = (await runTokensCli(["issue", "--user", "beta", "--auth-dir", options.authDir])) as {
    token: string;
  };

  const betaBootstrapRes = await fetch(`${origin}/api/shell/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${betaTokenResult.token}` }
  });
  expect(betaBootstrapRes.status).toBe(200);
  const betaBootstrap = (await betaBootstrapRes.json()) as {
    attachmentId: string;
    snapshot: { activeWorkspaceId: string | null };
  };
  expect(betaBootstrap.attachmentId).toMatch(/^web_/);
  expect(betaBootstrap.attachmentId).not.toBe(shellBootstrap.attachmentId);
  expect(betaBootstrap.snapshot.activeWorkspaceId).toBe("workspace.1");

  const betaClients = await fetchJson<{
    ok: true;
    clients: Array<{ clientId: string }>;
  }>(`${origin}/api/clients`, {
    headers: { authorization: `Bearer ${betaTokenResult.token}` }
  });
  expect(betaClients.clients).toHaveLength(1);
  expect(betaClients.clients[0].clientId).not.toBe(authorityClientId);

  // Beta's pane list contains only the default seed (cowsay + browser);
  // admin's three extra panes (browser + terminal + cowsay from earlier
  // in this scenario) don't leak across user boundaries.
  const betaPanes = await postJson<{
    ok: true;
    result: {
      ok: true;
      found: true;
      value: Record<string, { kind: string }>;
    };
  }>(
    `${origin}/api/model/path/get`,
    {
      clientId: betaClients.clients[0].clientId,
      path: "/status/workspaces/workspace.1/panes"
    },
    {
      headers: { authorization: `Bearer ${betaTokenResult.token}` }
    }
  );
  const betaPaneKinds = Object.values(betaPanes.result.value)
    .map((pane) => pane.kind)
    .sort();
  expect(betaPaneKinds).toEqual(["browser", "cowsay"]);

  // Cross-user clientId rejection: admin's clientId on beta's route is
  // refused by assertAuthorityClientId (beta's router pins its own id).
  const crossUserRes = await fetch(`${origin}/api/model/path/get`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${betaTokenResult.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      clientId: authorityClientId,
      path: "/status/app"
    })
  });
  // 400 — the router rejects the admin clientId presented on beta's
  // authenticated route via `assertAuthorityClientId`.
  expect(crossUserRes.status).toBe(400);
  const crossUserBody = (await crossUserRes.json()) as { ok: false; error: string };
  expect(crossUserBody.error).toContain("Unknown flmux client");

  // Cookie-continuity cross-user safety: presenting admin's attachmentId
  // cookie with beta's auth must NOT reuse — mints fresh for beta, so
  // admin's slot state stays private to admin.
  const crossUserReuseRes = await fetch(`${origin}/api/shell/bootstrap`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${betaTokenResult.token}`,
      cookie: `flmux-attachment=${shellBootstrap.attachmentId}`
    }
  });
  expect(crossUserReuseRes.status).toBe(200);
  const crossUserReuseBody = (await crossUserReuseRes.json()) as { attachmentId: string };
  expect(crossUserReuseBody.attachmentId).not.toBe(shellBootstrap.attachmentId);
  expect(crossUserReuseBody.attachmentId).not.toBe(betaBootstrap.attachmentId);
}

function cookieFromSetCookie(setCookie: string | null) {
  if (!setCookie) {
    throw new Error("expected auth cookie to be set");
  }

  return setCookie.split(";")[0];
}

function extractModuleAssetPath(html: string) {
  const match = /<script[^>]+src="([^"]+)"/i.exec(html);
  return match?.[1] ?? null;
}

async function runCliJson(args: string[]) {
  const subprocess = Bun.spawn({
    cmd: [resolveBunCommand(), "src/cli.ts", ...args],
    cwd: resolve(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(`CLI failed (${exitCode}): ${stderr || stdout}`.trim());
  }

  return JSON.parse(stdout) as unknown;
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}
