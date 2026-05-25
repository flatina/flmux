import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFlmuxAuthPaths } from "../src/main/auth/authConfig";
import { createFlmuxWebModeAuthorizer } from "../src/main/webModeAuth";
import { runTokensCli } from "../src/cliTokens";
import { startFlmuxServer } from "../src/main/server";
import { parseTrailingJson } from "./smokeHarness";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("web mode auth (users + tokens store)", () => {
  it("authorizes via cookie and bearer while keeping /health public", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as {
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

      // Human `?token=` query path is retired; a token in the cookie still
      // authorizes (the passkey session cookie reuses this exact mechanism).
      const withCookie = await fetch(`${server.origin}/api/clients`, {
        headers: { cookie: `flmux_web_token=${encodeURIComponent(bootstrap.token)}` }
      });
      expect(withCookie.status).toBe(200);

      const withBearer = await fetch(`${server.origin}/api/clients`, {
        headers: { authorization: `Bearer ${bootstrap.token}` }
      });
      expect(withBearer.status).toBe(200);

      const cliResult = await runCliJson(["clients", "--origin", server.origin, "--token", bootstrap.token]);
      expect(cliResult).toMatchObject({ ok: true });
    } finally {
      server.stop();
    }
  });

  it("rejects tokens with unparseable expires_at (defense in depth)", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as { token: string; tokenId: string };

    // Corrupt the tokens.toml to inject a malformed expires_at — simulates hand-edit.
    const tokensPath = join(authDir, "users.tokens.toml");
    const original = await readFile(tokensPath, "utf8");
    await writeFile(tokensPath, original.replace("label = ", 'expires_at = "not-a-date"\nlabel = '), "utf8");

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
    const bootstrap = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as { token: string; tokenId: string };

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
    const issued = (await runTokensCli([
      "bootstrap",
      "--name",
      "alice",
      "--allow-pane-kinds",
      "browser",
      "--auth-dir",
      authDir
    ])) as { token: string };

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
      const deniedBody = (await denied.json()) as { ok: boolean; error: string };
      expect(deniedBody.ok).toBe(false);
      expect(deniedBody.error).toContain("terminal");
      expect(calls).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("--dev-auth-as bypasses the token check and adopts users.toml ACL when the user exists", async () => {
    const { rendererDir, authDir } = await createFixture();
    // Seed a scoped user so the dev bypass still respects their ACL.
    await writeFile(
      join(authDir, "users.toml"),
      [`[[users]]`, `name = "scoped"`, `allow_pane_kinds = ["browser"]`, `allow_paths.read = ["/status/**"]`, ``].join(
        "\n"
      ),
      "utf8"
    );

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir), { devAuthAs: "scoped" })
    });

    try {
      // No token, no cookie — dev bypass still authorizes as 'scoped'.
      const clients = await fetch(`${server.origin}/api/clients`);
      expect(clients.status).toBe(200);

      // Seeded user's ACL allows read under /status/** but nothing else.
      const allowed = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/status/app" })
      });
      expect(allowed.status).toBe(200);

      const denied = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/workspaces" })
      });
      expect(denied.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  it("--dev-auth-as reflects live users.toml edits without a server restart", async () => {
    const { rendererDir, authDir } = await createFixture();
    const usersPath = join(authDir, "users.toml");

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir), { devAuthAs: "scoped" })
    });

    try {
      // Before any users.toml — synthesized `*` user allows /workspaces read.
      const before = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/workspaces" })
      });
      expect(before.status).toBe(200);

      // Write users.toml narrowing 'scoped' — next request must see the new ACL.
      await writeFile(
        usersPath,
        [`[[users]]`, `name = "scoped"`, `allow_pane_kinds = "*"`, `allow_paths.read = ["/status/**"]`, ``].join("\n"),
        "utf8"
      );

      const afterDenied = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/workspaces" })
      });
      expect(afterDenied.status).toBe(403);

      const afterAllowed = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/status/app" })
      });
      expect(afterAllowed.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  it("--dev-auth-as synthesizes a `*`-permission user when the name is absent from users.toml", async () => {
    const { rendererDir, authDir } = await createFixture();
    // Leave users.toml absent entirely — dev bypass must still succeed.

    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createStubShellModelRouter(),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir), { devAuthAs: "anon" })
    });

    try {
      const clients = await fetch(`${server.origin}/api/clients`);
      expect(clients.status).toBe(200);

      // Path ACL is "*" → any path goes through.
      const call = await fetch(`${server.origin}/api/model/path/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c", path: "/panes/new", args: { kind: "terminal" } })
      });
      expect(call.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  it("enforces allow_paths.{read,write,call} on /api/model/path/* (B3 ACL)", async () => {
    const { rendererDir, authDir } = await createFixture();
    const bootstrap = (await runTokensCli(["bootstrap", "--name", "scoped", "--auth-dir", authDir])) as {
      token: string;
    };

    // Hand-edit users.toml to narrow the user's path ACL: reads allowed
    // everywhere under /status, writes denied entirely, calls only on
    // /panes/*/close.
    const usersToml = [
      `# users.toml`,
      ``,
      `[[users]]`,
      `name = "scoped"`,
      `allow_pane_kinds = "*"`,
      `allow_paths.read = ["/status/**"]`,
      `allow_paths.call = ["/panes/*/close"]`,
      ``
    ].join("\n");
    await writeFile(join(authDir, "users.toml"), usersToml, "utf8");

    const calls: Array<{ path: string; method: "get" | "set" | "call" }> = [];
    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => ({
        ...createStubShellModelRouter(),
        pathGet: async (input) => {
          calls.push({ path: input.path, method: "get" });
          return { ok: true, found: true, value: null };
        },
        pathSet: async (input) => {
          calls.push({ path: input.path, method: "set" });
          return { ok: true, value: null };
        },
        pathCall: async (input) => {
          calls.push({ path: input.path, method: "call" });
          return { ok: true, value: null };
        }
      }),
      authorizer: createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(authDir))
    });

    async function post(route: string, body: Record<string, unknown>) {
      return await fetch(`${server.origin}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bootstrap.token}`
        },
        body: JSON.stringify({ clientId: "c", ...body })
      });
    }

    try {
      // read allowed under /status/**
      expect((await post("/api/model/path/get", { path: "/status/app" })).status).toBe(200);
      // read denied outside /status (allow_paths.read doesn't cover it)
      const readDenied = await post("/api/model/path/get", { path: "/workspaces" });
      expect(readDenied.status).toBe(403);
      expect(((await readDenied.json()) as { error: string }).error).toContain("read");

      // write denied everywhere — allow_paths.write is absent (empty)
      const writeDenied = await post("/api/model/path/set", { path: "/status/app/title", value: "x" });
      expect(writeDenied.status).toBe(403);

      // call allowed only on /panes/*/close
      expect((await post("/api/model/path/call", { path: "/panes/pane.xyz/close" })).status).toBe(200);
      const callDenied = await post("/api/model/path/call", { path: "/panes/new", args: { kind: "browser" } });
      expect(callDenied.status).toBe(403);
      expect(((await callDenied.json()) as { error: string }).error).toContain("call");

      // Router was only invoked on the allowed requests (2).
      expect(calls.map((c) => c.method).sort()).toEqual(["call", "get"]);
    } finally {
      server.stop();
    }
  });
});

function createStubShellModelRouter() {
  return {
    registerClient: () => ({ clientId: "server-client" }),
    listClients: async () => [
      {
        authorityClientId: "server-client",
        viewId: 0,
        workspace: {
          id: "workspace.1",
          title: "Workspace 1",
          defaultTitle: "Workspace 1",
          paneCount: 1
        }
      }
    ],
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

  return parseTrailingJson(stdout);
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}
