import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { createFsUploader } from "../src/main/fsBackend";
import { startFlmuxServer } from "../src/main/server";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// A real listening server with a no-authorizer (desktop-like) uploader, so we
// exercise the actual Elysia POST path — proving `request.body` streams (not
// pre-buffered/locked) and the chunk→staging→rename flow commits over HTTP.
function startServer() {
  const root = mkdtempSync(join(tmpdir(), "flmux-upload-route-"));
  tempDirs.push(root);
  const policy: ExtensionFsPolicy = { unconfined: true, binds: [] };
  const uploader = createFsUploader({ policy, projectDir: root, stagingDir: join(root, ".flmux-staging", "user") });
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
    resolveFsUploader: () => uploader
  });
  return { server, root };
}

function uploadUrl(origin: string, path: string, q: Record<string, string> = {}): string {
  const params = new URLSearchParams({ path, uploadId: "routetestid01", ...q });
  return `${origin}/api/fs/upload?${params}`;
}

describe("/api/fs/upload route", () => {
  it("streams a chunked file through Elysia and commits via rename", async () => {
    const { server, root } = startServer();
    try {
      const u = (q: Record<string, string>) => uploadUrl(server.origin, "/dir/sub/file.bin", q);
      const r1 = await fetch(u({ offset: "0", final: "0" }), { method: "POST", body: new Uint8Array([1, 2, 3]) });
      expect(await r1.json()).toEqual({ ok: true, result: { size: 3, committed: false } });
      // Not yet visible — only the .part exists.
      const r2 = await fetch(u({ offset: "3", final: "1" }), { method: "POST", body: new Uint8Array([4, 5]) });
      expect(await r2.json()).toEqual({ ok: true, result: { size: 5, committed: true } });
      expect([...readFileSync(join(root, "dir", "sub", "file.bin"))]).toEqual([1, 2, 3, 4, 5]);
    } finally {
      server.stop();
    }
  });

  it("commits a 0-byte file (empty POST body → request.body null)", async () => {
    const { server, root } = startServer();
    try {
      const res = await fetch(uploadUrl(server.origin, "/empty.txt"), { method: "POST", body: new Uint8Array(0) });
      expect(await res.json()).toEqual({ ok: true, result: { size: 0, committed: true } });
      expect(readFileSync(join(root, "empty.txt")).length).toBe(0);
    } finally {
      server.stop();
    }
  });

  it("a 2 MiB chunk streams through (raised global cap, not garbled by Elysia)", async () => {
    const { server, root } = startServer();
    try {
      const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => i & 0xff);
      const res = await fetch(uploadUrl(server.origin, "/big.bin"), { method: "POST", body: big });
      expect(await res.json()).toEqual({ ok: true, result: { size: big.length, committed: true } });
      expect(readFileSync(join(root, "big.bin")).length).toBe(big.length);
    } finally {
      server.stop();
    }
  });

  it("JSON-RPC re-bounds to 1 MiB despite the raised global cap (413)", async () => {
    const { server } = startServer();
    try {
      const huge = JSON.stringify({ path: "/x", pad: "a".repeat(2 * 1024 * 1024) });
      const res = await fetch(`${server.origin}/api/model/path/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge
      });
      expect(res.status).toBe(413);
    } finally {
      server.stop();
    }
  });

  it("rejects a traversal / reserved leaf with 400", async () => {
    const { server } = startServer();
    try {
      const bad = await fetch(uploadUrl(server.origin, "/a/../escape.bin"), {
        method: "POST",
        body: new Uint8Array([1])
      });
      expect(bad.status).toBe(400);
      const ads = await fetch(uploadUrl(server.origin, "/x.bin:ads"), { method: "POST", body: new Uint8Array([1]) });
      expect(ads.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  it("no-clobber → 409; overwrite=1 replaces", async () => {
    const { server, root } = startServer();
    try {
      await fetch(uploadUrl(server.origin, "/c.bin"), { method: "POST", body: new Uint8Array([1]) });
      const clob = await fetch(uploadUrl(server.origin, "/c.bin"), { method: "POST", body: new Uint8Array([2]) });
      expect(clob.status).toBe(409);
      const over = await fetch(uploadUrl(server.origin, "/c.bin", { overwrite: "1" }), {
        method: "POST",
        body: new Uint8Array([9])
      });
      expect(over.ok).toBe(true);
      expect([...readFileSync(join(root, "c.bin"))]).toEqual([9]);
    } finally {
      server.stop();
    }
  });

  it("404 when no uploader is configured (desktop)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flmux-upload-none-"));
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
      })
      // no resolveFsUploader
    });
    try {
      const res = await fetch(uploadUrl(server.origin, "/x.bin"), { method: "POST", body: new Uint8Array([1]) });
      expect(res.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
