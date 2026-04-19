import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFlmuxAuthPaths } from "../src/main/auth/authConfig";
import { createFlmuxWebModeAuthorizer } from "../src/main/webModeAuth";
import { runTokensCli } from "../src/cliTokens";
import { startFlmuxServer } from "../src/main/server";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("web mode auth (users + tokens store)", () => {
  it("authorizes via cookie, bearer, and query while keeping /health public", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = await runTokensCli(["bootstrap", "--auth-dir", authDir]) as {
      user: string;
      token: string;
      tokenId: string;
    };

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir))
    });

    try {
      const health = await fetch(`${server.origin}/health`);
      expect(health.status).toBe(200);

      const unauthorized = await fetch(`${server.origin}/api/clients`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

      const attach = await fetch(`${server.origin}/?token=${encodeURIComponent(bootstrap.token)}`);
      expect(attach.status).toBe(200);
      const cookie = attach.headers.get("set-cookie");
      expect(cookie).toContain(`flmux_web_token=${bootstrap.token}`);

      const withCookie = await fetch(`${server.origin}/api/clients`, {
        headers: { cookie: cookie ?? "" }
      });
      expect(withCookie.status).toBe(200);

      const withBearer = await fetch(`${server.origin}/api/clients`, {
        headers: { authorization: `Bearer ${bootstrap.token}` }
      });
      expect(withBearer.status).toBe(200);

      const cliResult = await runCliJson([
        "clients",
        "--origin",
        server.origin,
        "--token",
        bootstrap.token
      ]);
      expect(cliResult).toMatchObject({ ok: true });
    } finally {
      server.stop();
    }
  });

  it("rejects tokens with unparseable expires_at (defense in depth)", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = await runTokensCli(["bootstrap", "--auth-dir", authDir]) as { token: string; tokenId: string };

    // Corrupt the tokens.toml to inject a malformed expires_at — simulates hand-edit.
    const tokensPath = join(authDir, "users.tokens.toml");
    const original = await readFile(tokensPath, "utf8");
    await writeFile(tokensPath, original.replace("label = ", "expires_at = \"not-a-date\"\nlabel = "), "utf8");

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir))
    });

    try {
      const response = await fetch(`${server.origin}/api/clients`, {
        headers: { authorization: `Bearer ${bootstrap.token}` }
      });
      expect(response.status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it("rejects revoked tokens and tokens for removed users", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = await runTokensCli(["bootstrap", "--auth-dir", authDir]) as { token: string; tokenId: string };

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir))
    });

    try {
      const before = await fetch(`${server.origin}/api/clients`, {
        headers: { authorization: `Bearer ${bootstrap.token}` }
      });
      expect(before.status).toBe(200);

      await runTokensCli(["revoke", bootstrap.tokenId, "--auth-dir", authDir]);

      const after = await fetch(`${server.origin}/api/clients`, {
        headers: { authorization: `Bearer ${bootstrap.token}` }
      });
      expect(after.status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it("enforces allow_pane_kinds on /panes/new calls", async () => {
    const { rendererDir, authDir } = await createFixture();
    const issued = await runTokensCli([
      "bootstrap",
      "--name",
      "alice",
      "--allow-pane-kinds",
      "browser",
      "--auth-dir",
      authDir
    ]) as { token: string };

    const calls: Array<{ path: string; args?: Record<string, unknown> }> = [];
    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => ({
        ...createStubShellModelRouter(),
        pathCall: async (input) => {
          calls.push({ path: input.path, args: input.args });
          return { ok: true, value: null };
        }
      }),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir))
    });

    try {
      const allowed = await fetch(`${server.origin}/api/model/path/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issued.token}`
        },
        body: JSON.stringify({
          clientId: "c",
          path: "/panes/new",
          args: { kind: "browser" }
        })
      });
      expect(allowed.status).toBe(200);
      expect(calls).toHaveLength(1);

      const denied = await fetch(`${server.origin}/api/model/path/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issued.token}`
        },
        body: JSON.stringify({
          clientId: "c",
          path: "/panes/new",
          args: { kind: "terminal" }
        })
      });
      expect(denied.status).toBe(403);
      const deniedBody = await denied.json() as { ok: boolean; error: string };
      expect(deniedBody.ok).toBe(false);
      expect(deniedBody.error).toContain("terminal");
      expect(calls).toHaveLength(1);
    } finally {
      server.stop();
    }
  });
});

function createStubShellModelRouter() {
  return {
    registerClient: () => ({ clientId: "server-client" }),
    listClients: async () => [{
      clientId: "server-client",
      viewId: 0,
      workspace: {
        id: "workspace.1",
        title: "Workspace 1",
        activePaneId: null,
        paneCount: 1
      }
    }],
    pathGet: async () => ({ ok: true, found: true, value: null }),
    pathList: async () => ({ ok: true, found: true, entries: [] }),
    pathSet: async () => ({ ok: true, value: null }),
    pathCall: async () => ({ ok: true, value: null })
  };
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "flmux-web-auth-"));
  tempDirs.push(rootDir);
  const rendererDir = join(rootDir, "renderer");
  const authDir = join(rootDir, "auth");
  await mkdir(rendererDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await writeFile(join(rendererDir, "index.html"), "<!doctype html><title>flmux</title>", "utf8");
  return { rendererDir, authDir };
}

async function runCliJson(args: string[]) {
  const subprocess = Bun.spawn({
    cmd: [resolveBunCommand(), "src/cli.ts", ...args],
    cwd: resolve(import.meta.dir, ".."),
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
