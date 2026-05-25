import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFlmuxAuthPaths } from "../src/main/auth/authConfig";
import { createFlmuxWebModeAuthorizer } from "../src/main/webModeAuth";
import { createWebauthnAuthService } from "../src/main/auth/webauthnService";
import { startFlmuxServer } from "../src/main/server";
import { runTokensCli } from "../src/cliTokens";
import { runAuthCli } from "../src/cliAuth";
import { CEREMONY_COOKIE } from "../src/main/auth/cookies";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flmux-webauthn-srv-"));
  tempDirs.push(root);
  const rendererDir = join(root, "renderer");
  const dir = join(root, "auth");
  await mkdir(rendererDir, { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(rendererDir, "index.html"), "<!doctype html><title>flmux</title>", "utf8");
  return { rendererDir, authDir: dir };
}

function startServer(rendererDir: string, dir: string) {
  const paths = resolveFlmuxAuthPaths(dir);
  const authorizer = createFlmuxWebModeAuthorizer(paths);
  const webauthn = createWebauthnAuthService({
    authorizer,
    webauthnFile: paths.webauthnFile,
    tokensFile: paths.tokensFile,
    publicOrigin: "https://flmux.example.ts.net"
  });
  const server = startFlmuxServer({
    rendererDir,
    resolveShellModelRouter: async () => ({
      registerClient: () => ({ clientId: "c" }),
      listClients: async () => [],
      pathGet: async () => ({ ok: true, found: true, value: null }),
      pathList: async () => ({ ok: true, found: true, entries: [] }),
      pathSet: async () => ({ ok: true, value: null }),
      pathCall: async () => ({ ok: true, value: null })
    }),
    authorizer,
    webauthn
  });
  return { server, webauthn };
}

describe("passkey auth server surface", () => {
  it("serves /login and /enroll without a session (carve-out, invariant #8)", async () => {
    const { rendererDir, authDir } = await fixture();
    const { server, webauthn } = startServer(rendererDir, authDir);
    try {
      expect((await fetch(`${server.origin}/login`)).status).toBe(200);
      expect((await fetch(`${server.origin}/enroll?token=x`)).status).toBe(200);

      // Authenticate options need no session and issue a ceremony cookie.
      const r = await fetch(`${server.origin}/api/auth/passkey/authenticate/options`, { method: "POST" });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { challenge?: string; allowCredentials?: unknown[] };
      expect(typeof body.challenge).toBe("string");
      // Usernameless / discoverable: empty allowCredentials (invariant #2).
      expect(body.allowCredentials).toEqual([]);
      expect(r.headers.get("set-cookie")).toContain(`${CEREMONY_COOKIE}=`);
    } finally {
      server.stop();
      webauthn.dispose();
    }
  });

  it("keeps non-carve-out routes behind auth; navigation redirects to /login", async () => {
    const { rendererDir, authDir } = await fixture();
    const { server, webauthn } = startServer(rendererDir, authDir);
    try {
      // XHR-style (no navigate) → 401, not redirect.
      const api = await fetch(`${server.origin}/api/clients`);
      expect(api.status).toBe(401);

      // Top-level navigation with no session → 302 to /login.
      const nav = await fetch(`${server.origin}/`, {
        headers: { "sec-fetch-mode": "navigate" },
        redirect: "manual"
      });
      expect(nav.status).toBe(302);
      expect(nav.headers.get("location")).toBe("/login");
    } finally {
      server.stop();
      webauthn.dispose();
    }
  });

  it("register/options accepts an enrollment token and rejects without authz", async () => {
    const { rendererDir, authDir } = await fixture();
    await runTokensCli(["bootstrap", "--name", "alice", "--auth-dir", authDir]);
    const enroll = (await runAuthCli(["enroll", "--user", "alice", "--auth-dir", authDir])) as { token: string };

    const { server, webauthn } = startServer(rendererDir, authDir);
    try {
      const unauthorized = await fetch(`${server.origin}/api/auth/passkey/register/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      expect(unauthorized.status).toBe(401);

      const ok = await fetch(`${server.origin}/api/auth/passkey/register/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: enroll.token })
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { challenge?: string; user?: { id?: string }; authenticatorSelection?: { residentKey?: string; userVerification?: string } };
      expect(typeof body.challenge).toBe("string");
      // Stable handle as user.id, not the username (invariant #4).
      expect(typeof body.user?.id).toBe("string");
      // Discoverable + UV required (invariant #2).
      expect(body.authenticatorSelection?.residentKey).toBe("required");
      expect(body.authenticatorSelection?.userVerification).toBe("required");
      expect(ok.headers.get("set-cookie")).toContain(`${CEREMONY_COOKIE}=`);
    } finally {
      server.stop();
      webauthn.dispose();
    }
  });

  it("logout clears the session cookie", async () => {
    const { rendererDir, authDir } = await fixture();
    const { server, webauthn } = startServer(rendererDir, authDir);
    try {
      const r = await fetch(`${server.origin}/api/auth/logout`, { method: "POST" });
      expect(r.status).toBe(200);
      expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      server.stop();
      webauthn.dispose();
    }
  });
});
