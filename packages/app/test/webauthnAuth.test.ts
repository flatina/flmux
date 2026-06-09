import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFlmuxAuthPaths } from "../src/main/auth/authConfig";
import { createFlmuxWebModeAuthorizer } from "../src/main/webModeAuth";
import { createTokenStore } from "../src/main/auth/tokenStore";
import { generateToken } from "../src/main/auth/tokenFormat";
import { createChallengeStore } from "../src/main/auth/webauthnStore";
import {
  serializeSessionCookie,
  serializeCeremonyCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  CEREMONY_COOKIE
} from "../src/main/auth/cookies";
import { runTokensCli } from "../src/cliTokens";
import { runAuthCli } from "../src/cliAuth";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function authDir() {
  const dir = await mkdtemp(join(tmpdir(), "flmux-webauthn-"));
  tempDirs.push(dir);
  return dir;
}

describe("enrollment-token isolation (invariant #1)", () => {
  it("never resolves an enrollment token to a session, but verifies it as an enrollment grant", async () => {
    const dir = await authDir();
    await runTokensCli(["bootstrap", "--name", "alice", "--auth-dir", dir]);
    const enroll = (await runAuthCli(["enroll", "--user", "alice", "--auth-dir", dir])) as { token: string };

    const authorizer = createFlmuxWebModeAuthorizer(resolveFlmuxAuthPaths(dir));

    // authorize() must NOT grant a session for the enrollment token.
    expect(authorizer.authorize(enroll.token)).toBeNull();
    // …but the enrollment helper accepts it (separate namespace).
    const grant = authorizer.verifyEnrollmentToken(enroll.token);
    expect(grant?.user).toBe("alice");
  });

  it("rejects an expired enrollment token", async () => {
    const dir = await authDir();
    await runTokensCli(["bootstrap", "--name", "bob", "--auth-dir", dir]);
    const paths = resolveFlmuxAuthPaths(dir);
    const store = createTokenStore(paths.tokensFile);
    const t = generateToken();
    store.append({
      id: t.id,
      user: "bob",
      tokenHash: t.hash,
      tokenPrefix: t.prefix,
      createdAt: new Date().toISOString(),
      kind: "enrollment",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const authorizer = createFlmuxWebModeAuthorizer(paths);
    expect(authorizer.verifyEnrollmentToken(t.value)).toBeNull();
    expect(authorizer.authorize(t.value)).toBeNull();
  });

  it("resolves a session token via authorize()", async () => {
    const dir = await authDir();
    await runTokensCli(["bootstrap", "--name", "carol", "--auth-dir", dir]);
    const paths = resolveFlmuxAuthPaths(dir);
    const store = createTokenStore(paths.tokensFile);
    const t = generateToken();
    store.append({
      id: t.id,
      user: "carol",
      tokenHash: t.hash,
      tokenPrefix: t.prefix,
      createdAt: new Date().toISOString(),
      kind: "session",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const authorizer = createFlmuxWebModeAuthorizer(paths);
    expect(authorizer.authorize(t.value)?.user.name).toBe("carol");
    // A session token is not an enrollment grant.
    expect(authorizer.verifyEnrollmentToken(t.value)).toBeNull();
  });
});

describe("tokenStore prune off the hot path (invariant #6)", () => {
  it("findByHash never drops an expired token; prune() does", async () => {
    const dir = await authDir();
    const file = join(dir, "users.tokens.toml");
    const store = createTokenStore(file);
    const t = generateToken();
    store.append({
      id: t.id,
      user: "x",
      tokenHash: t.hash,
      tokenPrefix: t.prefix,
      createdAt: new Date().toISOString(),
      kind: "session",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });

    // Hot path returns the (expired) record unchanged — expiry is enforced by
    // authorize(), not by mutating the store per request.
    expect(store.findByHash(t.hash)?.id).toBe(t.id);

    // Explicit prune removes it.
    expect(store.prune()).toBe(1);
    expect(store.findByHash(t.hash)).toBeNull();
  });

  it("sees an external revoke via mtime-based cache invalidation", async () => {
    const dir = await authDir();
    const file = join(dir, "users.tokens.toml");
    const store = createTokenStore(file);
    const t = generateToken();
    store.append({
      id: t.id,
      user: "x",
      tokenHash: t.hash,
      tokenPrefix: t.prefix,
      createdAt: new Date().toISOString(),
      kind: "machine"
    });
    expect(store.findByHash(t.hash)?.id).toBe(t.id);

    // Simulate an external CLI process rewriting the file (empty tokens).
    writeFileSync(file, "# emptied\n", "utf8");
    expect(store.findByHash(t.hash)).toBeNull();
  });
});

describe("challenge store (invariant #7)", () => {
  it("is single-use", () => {
    const store = createChallengeStore();
    const id = store.put({ challenge: "c1", kind: "authenticate" });
    expect(store.take(id)?.challenge).toBe("c1");
    expect(store.take(id)).toBeNull();
    store.dispose();
  });

  it("expires after its TTL", async () => {
    const store = createChallengeStore({ ttlMs: 5 });
    const id = store.put({ challenge: "c2", kind: "register", user: "u" });
    await Bun.sleep(15);
    expect(store.take(id)).toBeNull();
    store.dispose();
  });

  it("rejects new challenges past the size cap", () => {
    const store = createChallengeStore({ maxEntries: 2 });
    store.put({ challenge: "a", kind: "authenticate" });
    store.put({ challenge: "b", kind: "authenticate" });
    expect(() => store.put({ challenge: "c", kind: "authenticate" })).toThrow(/full/);
    store.dispose();
  });
});

describe("cookie flags (invariant #5)", () => {
  it("session cookie is HttpOnly + SameSite=Lax + Max-Age; Secure conditional", () => {
    const insecure = serializeSessionCookie("v", false);
    expect(insecure).toContain(`${SESSION_COOKIE}=v`);
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).toMatch(/Max-Age=\d+/);
    expect(insecure).not.toContain("Secure");

    expect(serializeSessionCookie("v", true)).toContain("Secure");
  });

  it("clear cookie sets Max-Age=0", () => {
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
  });

  it("ceremony cookie uses a distinct name from the session cookie", () => {
    const c = serializeCeremonyCookie("cid", false);
    expect(c).toContain(`${CEREMONY_COOKIE}=cid`);
    expect(CEREMONY_COOKIE).not.toBe(SESSION_COOKIE);
    expect(c).toContain("HttpOnly");
  });
});

describe("stable user handle (invariant #4)", () => {
  it("create-user persists a random handle distinct from the name, looked up by handle", async () => {
    const dir = await authDir();
    await runTokensCli(["bootstrap", "--name", "admin", "--auth-dir", dir]);
    await runAuthCli(["create-user", "--name", "dave", "--role", "basic", "--auth-dir", dir]);

    const paths = resolveFlmuxAuthPaths(dir);
    const usersToml = readFileSync(paths.usersFile, "utf8");
    expect(usersToml).toContain(`name = "dave"`);
    expect(usersToml).toContain("handle = ");

    const authorizer = createFlmuxWebModeAuthorizer(paths);
    const dave = authorizer.userStore.getUser("dave");
    expect(dave?.handle).toBeTruthy();
    expect(dave?.handle).not.toBe("dave");
    expect(authorizer.userStore.getUserByHandle(dave!.handle!)?.name).toBe("dave");
  });
});
