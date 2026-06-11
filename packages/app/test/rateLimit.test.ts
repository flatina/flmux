import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFlmuxServer } from "../src/main/server";
import type { FlmuxWebModeAuthorizer } from "../src/main/webModeAuth";

const servers: Array<{ stop(): void }> = [];
const tempDirs: string[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// Minimal authorizer so the limiter is active (desktop / no-authorizer skips it).
// Only the limiter + authorizeRequest path is exercised here.
const authorizer = {
  cookieName: "flmux_web_token",
  authorize: (token: string) => (token === "valid" ? { user: { name: "u1" }, tokenId: "t1" } : null),
  isPathAllowed: () => true,
  isPaneKindAllowed: () => true
} as unknown as FlmuxWebModeAuthorizer;

function startServer() {
  const root = mkdtempSync(join(tmpdir(), "flmux-ratelimit-"));
  tempDirs.push(root);
  const server = startFlmuxServer({
    rendererDir: root,
    resolveShellModelRouter: async () => ({
      registerClient: () => ({ clientId: "c" }),
      listClients: async () => [],
      pathGet: async () => ({ ok: true, found: true, value: null }),
      pathList: async () => ({ ok: true, found: true, entries: [] }),
      pathSet: async () => ({ ok: true, value: null }),
      pathCall: async () => ({ ok: true, value: null })
    }),
    authorizer,
    // Small max so a burst trips it fast; userMax stays well above.
    rateLimit: { max: 20, windowMs: 60_000, userMax: 200 }
  });
  servers.push(server);
  return server;
}

async function burst(url: string, n: number, headers: Record<string, string>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(url, { headers })).status);
  return out;
}

describe("rate limiter", () => {
  it("exempts /health from the limiter (liveness probes never 429)", async () => {
    const { origin } = startServer();
    const statuses = await burst(`${origin}/health`, 30, { "x-forwarded-for": "9.9.9.9" });
    expect(statuses).not.toContain(429);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("isolates the login surface from a general unauth flood (same NAT can still log in)", async () => {
    const { origin } = startServer();
    const xff = { "x-forwarded-for": "1.1.1.1" };
    const general = await burst(`${origin}/api/clients`, 30, xff);
    expect(general).toContain(429); // general ip:<ip> bucket is exhausted
    // Login surface is a separate auth:<ip> bucket — not drained by the flood.
    expect((await fetch(`${origin}/login`, { headers: xff })).status).toBe(200);
    expect((await fetch(`${origin}/health`, { headers: xff })).status).toBe(200);
  });

  it("still caps the login surface itself (its bucket is a real limit, not an exemption)", async () => {
    const { origin } = startServer();
    const statuses = await burst(`${origin}/login`, 30, { "x-forwarded-for": "3.3.3.3" });
    expect(statuses).toContain(429); // auth:<ip> bucket is limited, just separate from ip:<ip>
  });

  it("tolerates a malformed cookie (no 500 / limiter bypass)", async () => {
    const { origin } = startServer();
    const res = await fetch(`${origin}/login`, {
      headers: { "x-forwarded-for": "4.4.4.4", cookie: "flmux_web_token=%" }
    });
    expect(res.status).toBe(200);
  });

  it("gives authenticated requests the larger per-user bucket", async () => {
    const { origin } = startServer();
    const headers = { "x-forwarded-for": "2.2.2.2", authorization: "Bearer valid" };
    const statuses = await burst(`${origin}/api/clients`, 30, headers);
    expect(statuses).not.toContain(429); // u:<name> bucket (userMax 200) tolerates > max
  });
});
