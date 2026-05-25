import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTokensCli } from "../src/cliTokens";
import { buildEnrollUrl, runAuthCli } from "../src/cliAuth";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("cli tokens", () => {
  it("bootstraps an admin user and issues the first token", async () => {
    const authDir = await createTempAuthDir();

    const result = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as {
      ok: true;
      user: string;
      tokenId: string;
      tokenPrefix: string;
      token: string;
    };

    expect(result.ok).toBe(true);
    expect(result.user).toBe("admin");
    expect(result.tokenId).toMatch(/^tok_[a-f0-9]{16}$/);
    expect(result.token).toHaveLength(64);
    expect(result.tokenPrefix).toBe(result.token.slice(0, 8));

    const usersContent = await readFile(join(authDir, "users.toml"), "utf8");
    expect(usersContent).toContain(`name = "admin"`);
    expect(usersContent).toContain(`allow_pane_kinds = "*"`);

    const tokensContent = await readFile(join(authDir, "users.tokens.toml"), "utf8");
    expect(tokensContent).toContain(`id = "${result.tokenId}"`);
    expect(tokensContent).not.toContain(result.token);
  });

  it("refuses to re-bootstrap when users.toml already exists", async () => {
    const authDir = await createTempAuthDir();
    await runTokensCli(["bootstrap", "--auth-dir", authDir]);

    await expect(runTokensCli(["bootstrap", "--auth-dir", authDir])).rejects.toThrow(/already bootstrapped/);
  });

  it("issues extra tokens only for existing users", async () => {
    const authDir = await createTempAuthDir();
    await runTokensCli(["bootstrap", "--auth-dir", authDir]);

    const issued = (await runTokensCli(["issue", "--user", "admin", "--label", "second", "--auth-dir", authDir])) as {
      ok: true;
      tokenId: string;
    };
    expect(issued.tokenId).toMatch(/^tok_/);

    await expect(runTokensCli(["issue", "--user", "ghost", "--auth-dir", authDir])).rejects.toThrow(
      /User 'ghost' not found/
    );
  });

  it("revokes tokens by id and refuses unknown ids", async () => {
    const authDir = await createTempAuthDir();
    const bootstrap = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as { tokenId: string };

    const revoked = (await runTokensCli(["revoke", bootstrap.tokenId, "--auth-dir", authDir])) as {
      ok: true;
      tokenId: string;
    };
    expect(revoked.tokenId).toBe(bootstrap.tokenId);

    const listed = (await runTokensCli(["list", "--auth-dir", authDir])) as { tokens: unknown[] };
    expect(listed.tokens).toHaveLength(0);

    await expect(runTokensCli(["revoke", bootstrap.tokenId, "--auth-dir", authDir])).rejects.toThrow(/not found/);
  });

  it("lists tokens without exposing plaintext values", async () => {
    const authDir = await createTempAuthDir();
    const issued = (await runTokensCli(["bootstrap", "--auth-dir", authDir])) as { token: string };

    const listed = (await runTokensCli(["list", "--auth-dir", authDir])) as {
      tokens: Array<{ id: string; prefix: string; token?: string }>;
    };

    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0].token).toBeUndefined();
    expect(listed.tokens[0].prefix).toBe(issued.token.slice(0, 8));
  });

  it("supports narrow allow_pane_kinds for bootstrap", async () => {
    const authDir = await createTempAuthDir();
    const bootstrap = (await runTokensCli([
      "bootstrap",
      "--name",
      "alice",
      "--allow-pane-kinds",
      "browser,terminal",
      "--auth-dir",
      authDir
    ])) as { user: string };
    expect(bootstrap.user).toBe("alice");

    const users = (await runTokensCli(["users", "--auth-dir", authDir])) as {
      users: Array<{ name: string; allowPaneKinds: string | string[] }>;
    };
    expect(users.users).toHaveLength(1);
    expect(users.users[0].name).toBe("alice");
    expect(users.users[0].allowPaneKinds).toEqual(["browser", "terminal"]);
  });

  it("rejects invalid --expires-at at issue time", async () => {
    const authDir = await createTempAuthDir();
    await runTokensCli(["bootstrap", "--auth-dir", authDir]);

    await expect(
      runTokensCli(["issue", "--user", "admin", "--expires-at", "not-a-date", "--auth-dir", authDir])
    ).rejects.toThrow(/not a valid ISO timestamp/);
  });

  it("builds enroll urls and rejects non-http origins", () => {
    expect(buildEnrollUrl("http://127.0.0.1:1234", "abc")).toBe("http://127.0.0.1:1234/enroll?token=abc");
    expect(buildEnrollUrl("http://127.0.0.1:1234/", "abc")).toBe("http://127.0.0.1:1234/enroll?token=abc");
    expect(buildEnrollUrl("https://example.com/base", "a b/c")).toBe("https://example.com/base/enroll?token=a%20b%2Fc");
    expect(() => buildEnrollUrl("file:///foo", "t")).toThrow(/must start with http/);
    expect(() => buildEnrollUrl("127.0.0.1", "t")).toThrow(/must start with http/);
  });

  it("auth enroll issues an enrollment-namespace token bound to an existing user", async () => {
    const authDir = await createTempAuthDir();
    await runTokensCli(["bootstrap", "--name", "alice", "--auth-dir", authDir]);

    const result = (await runAuthCli(["enroll", "--user", "alice", "--auth-dir", authDir])) as {
      ok: true;
      tokenId: string;
      token: string;
    };
    expect(result.tokenId).toMatch(/^tok_/);

    const tokensContent = await readFile(join(authDir, "users.tokens.toml"), "utf8");
    expect(tokensContent).toContain(`kind = "enrollment"`);

    await expect(runAuthCli(["enroll", "--user", "ghost", "--auth-dir", authDir])).rejects.toThrow(
      /User 'ghost' not found/
    );
  });

  it("rejects newline injection in user name and label", async () => {
    const authDir = await createTempAuthDir();
    await expect(
      runTokensCli(["bootstrap", "--name", 'admin\n[[users]]\nname = "evil"', "--auth-dir", authDir])
    ).rejects.toThrow(/control characters/);

    await runTokensCli(["bootstrap", "--auth-dir", authDir]);
    await expect(
      runTokensCli(["issue", "--user", "admin", "--label", "first\nsecond", "--auth-dir", authDir])
    ).rejects.toThrow(/control characters/);
  });
});

async function createTempAuthDir() {
  const dir = await mkdtemp(join(tmpdir(), "flmux-auth-cli-"));
  tempDirs.push(dir);
  return dir;
}
