import { expect } from "bun:test";
import { resolve } from "node:path";
import type { AppProcessHandle } from "../support/realAppSmokeSupport";
import {
  fetchJson,
  postJson,
  waitFor,
  waitForWebAccessUrl
} from "../support/realAppSmokeSupport";

export async function runWebModeBootSmokeScenario(appHandles: AppProcessHandle[]) {
  const handle = appHandles[appHandles.length - 1];
  if (!handle) {
    throw new Error("web app handle is required");
  }

  const access = await waitForWebAccessUrl(handle, "web access url");
  expect(access.token.length).toBeGreaterThan(0);

  const attachResponse = await fetch(access.url);
  expect(attachResponse.status).toBe(200);
  const setCookie = attachResponse.headers.get("set-cookie");
  expect(setCookie).toContain(`flmux_web_token=${access.token}`);
  const html = await attachResponse.text();
  expect(html).toContain('id="app"');
  expect(html).toContain("<script");

  const cookieHeader = cookieFromSetCookie(setCookie);
  const assetPath = extractModuleAssetPath(html);
  expect(assetPath).not.toBeNull();
  const assetResponse = await fetch(`${access.origin}${assetPath}`, {
    headers: {
      cookie: cookieHeader
    }
  });
  expect(assetResponse.status).toBe(200);

  const unauthorizedClients = await fetch(`${access.origin}/api/clients`);
  expect(unauthorizedClients.status).toBe(401);

  const clients = await fetchJson<{
    ok: true;
    clients: Array<{
      clientId: string;
      workspace: {
        id: string;
        title: string;
        activePaneId: string | null;
        paneCount: number;
      } | null;
    }>;
  }>(`${access.origin}/api/clients`, {
    headers: {
      cookie: cookieHeader
    }
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
  }>(`${access.origin}/api/model/path/call`, {
    clientId: authorityClientId,
    path: "/panes/new",
    args: {
      kind: "browser",
      url: "/__flmux/internal/start?workspace=workspace.1",
      place: "right"
    }
  }, {
    headers: {
      cookie: cookieHeader
    }
  });
  expect(createdBrowser.result.value.pane.kind).toBe("browser");

  const cliCreatedTerminal = await runCliJson([
    "call",
    "/panes/new",
    "kind=terminal",
    "cwd=.",
    "--origin",
    access.origin,
    "--token",
    access.token
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

  await waitFor(async () => {
    const panes = await postJson<{
      ok: true;
      result: {
        ok: true;
        found: true;
        value: Record<string, { kind: string; title: string }>;
      };
    }>(`${access.origin}/api/model/path/get`, {
      clientId: authorityClientId,
      path: "/status/panes"
    }, {
      headers: {
        cookie: cookieHeader
      }
    });

    const paneKinds = Object.values(panes.result.value).map((pane) => pane.kind);
    return paneKinds.filter((kind) => kind === "browser").length >= 2 && paneKinds.includes("terminal")
      ? panes.result.value
      : null;
  }, { timeoutMs: 15_000, intervalMs: 250, label: "web mode pane list after API and CLI calls" });
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
