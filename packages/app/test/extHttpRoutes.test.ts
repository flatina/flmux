import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionServerDefinition } from "@flmux/extension-api";
import { collectExtHttpRoutes, type ResolvedExtHttpRoute } from "../src/main/extHttpRoutes";
import { startFlmuxServer } from "../src/main/server";
import type { FlmuxUser } from "../src/main/auth/userStore";
import type { FlmuxWebModeAuthorizer } from "../src/main/webModeAuth";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const GOOD_TOKEN = "tok-good";

function rendererDir(): string {
  const root = mkdtempSync(join(tmpdir(), "flmux-exthttp-"));
  tempDirs.push(root);
  const dir = join(root, "renderer");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>flmux</title>", "utf8");
  return dir;
}

function stubAuthorizer(): FlmuxWebModeAuthorizer {
  return {
    cookieName: "flmux_web_token",
    authorize: (token: string) =>
      token === GOOD_TOKEN ? { user: { name: "alice" } as unknown as FlmuxUser, tokenId: "t1" } : null
  } as unknown as FlmuxWebModeAuthorizer;
}

function boot(opts: {
  routes: ResolvedExtHttpRoute[];
  authorizer?: FlmuxWebModeAuthorizer;
  isExtensionEnabled?: (extId: string) => boolean;
  canUseExtension?: (userId: string, extId: string) => boolean;
}) {
  return startFlmuxServer({
    rendererDir: rendererDir(),
    resolveShellModelRouter: async () => ({
      registerClient: () => ({ clientId: "c" }),
      listClients: async () => [],
      pathGet: async () => ({ ok: true, found: true, value: null }),
      pathList: async () => ({ ok: true, found: true, entries: [] }),
      pathSet: async () => ({ ok: true, value: null }),
      pathCall: async () => ({ ok: true, value: null })
    }),
    extHttpRoutes: opts.routes,
    authorizer: opts.authorizer,
    isExtensionEnabled: opts.isExtensionEnabled ?? (() => true),
    canUseExtension: opts.canUseExtension ?? (() => true)
  });
}

const EXT = "sample.ext";
const url = (origin: string, path: string) => `${origin}/api/ext/${EXT}${path}`;

describe("collectExtHttpRoutes", () => {
  it("keeps valid routes (with extId/dataDir) and drops invalid/dup", () => {
    const defs = new Map<string, ExtensionServerDefinition>([
      [
        "good.ext",
        {
          httpRoutes: [
            { method: "GET", path: "/a", auth: "public", handler: () => "" },
            { method: "POST", path: "/a", auth: "session", handler: () => "" }, // distinct method — kept
            { method: "GET", path: "/a", auth: "public", handler: () => "" }, // dup — dropped
            { method: "POST", path: "/x", auth: "public", handler: () => "" }, // public POST — dropped
            { method: "GET", path: "/../escape", auth: "public", handler: () => "" } // traversal — dropped
          ]
        }
      ],
      ["no.datadir", { httpRoutes: [{ method: "GET", path: "/a", auth: "public", handler: () => "" }] }]
    ]);
    const resolved = collectExtHttpRoutes(defs, (id) => (id === "no.datadir" ? null : "/data"));
    expect(resolved.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /a", "POST /a"]);
    expect(resolved[0]!.extId).toBe("good.ext");
    expect(resolved[0]!.dataDir).toBe("/data");
  });
});

describe("extension HTTP routes — serving", () => {
  it("filters response headers, forces nosniff+CSP, never emits ACAO", async () => {
    const server = boot({
      routes: [
        {
          extId: EXT,
          method: "GET",
          path: "/probe",
          auth: "public",
          dataDir: "/tmp",
          handler: () => ({
            headers: { "Content-Type": "text/plain", "access-control-allow-origin": "*", "set-cookie": "x=1" },
            body: "tok"
          })
        }
      ]
    });
    try {
      const r = await fetch(url(server.origin, "/probe"));
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("tok");
      expect(r.headers.get("content-type")).toContain("text/plain"); // capitalized key kept (case-insensitive)
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
    } finally {
      server.stop();
    }
  });

  it("bare string return ⇒ text/plain body; cookie/authorization redacted in header()", async () => {
    const server = boot({
      routes: [
        {
          extId: EXT,
          method: "GET",
          path: "/echo",
          auth: "public",
          dataDir: "/tmp",
          handler: ({ request }) =>
            JSON.stringify({
              cookie: request.header("cookie"),
              authorization: request.header("Authorization"),
              x: request.header("x-test")
            })
        }
      ]
    });
    try {
      const r = await fetch(url(server.origin, "/echo"), {
        headers: { cookie: "s=1", authorization: "Bearer z", "x-test": "yes" }
      });
      expect(r.headers.get("content-type")).toContain("text/plain");
      expect(await r.json()).toEqual({ cookie: null, authorization: null, x: "yes" });
    } finally {
      server.stop();
    }
  });

  it("session route: 401 without token, 200 + userId when entitled", async () => {
    const server = boot({
      authorizer: stubAuthorizer(),
      canUseExtension: () => true,
      routes: [
        {
          extId: EXT,
          method: "GET",
          path: "/me",
          auth: "session",
          dataDir: "/tmp",
          handler: ({ userId }) => userId ?? "anon"
        }
      ]
    });
    try {
      expect((await fetch(url(server.origin, "/me"))).status).toBe(401);
      const ok = await fetch(url(server.origin, "/me"), { headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("alice");
    } finally {
      server.stop();
    }
  });

  it("session route: 403 when not entitled", async () => {
    const server = boot({
      authorizer: stubAuthorizer(),
      canUseExtension: () => false,
      routes: [{ extId: EXT, method: "GET", path: "/me", auth: "session", dataDir: "/tmp", handler: () => "ok" }]
    });
    try {
      const r = await fetch(url(server.origin, "/me"), { headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
      expect(r.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  it("desktop (no authorizer): session route is single-user, userId = '_root'", async () => {
    const server = boot({
      routes: [
        {
          extId: EXT,
          method: "GET",
          path: "/me",
          auth: "session",
          dataDir: "/tmp",
          handler: ({ userId }) => userId ?? "null"
        }
      ]
    });
    try {
      const r = await fetch(url(server.origin, "/me"));
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("_root");
    } finally {
      server.stop();
    }
  });

  it("disabled extension (isExtensionEnabled=false) ⇒ 404", async () => {
    const server = boot({
      isExtensionEnabled: () => false,
      routes: [{ extId: EXT, method: "GET", path: "/probe", auth: "public", dataDir: "/tmp", handler: () => "x" }]
    });
    try {
      expect((await fetch(url(server.origin, "/probe"))).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("handler throw ⇒ generic 500 (no detail leaked)", async () => {
    const server = boot({
      routes: [
        {
          extId: EXT,
          method: "GET",
          path: "/boom",
          auth: "public",
          dataDir: "/tmp",
          handler: () => {
            throw new Error("/secret/host/path leaked");
          }
        }
      ]
    });
    try {
      const r = await fetch(url(server.origin, "/boom"));
      expect(r.status).toBe(500);
      expect(await r.text()).toBe("Internal Server Error");
    } finally {
      server.stop();
    }
  });
});
