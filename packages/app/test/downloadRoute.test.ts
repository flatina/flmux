import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { attachmentDisposition, createFsDownloader } from "../src/main/fsDownload";
import { startFlmuxServer } from "../src/main/server";

/** Extract a downloaded tar.gz to `{ entry: text }`, stripping tar's `./` prefix. */
async function tarGzEntries(res: Response): Promise<Record<string, string>> {
  const files = await new Bun.Archive(new Uint8Array(await res.arrayBuffer())).files();
  const out: Record<string, string> = {};
  for (const [key, file] of files) {
    if (key.endsWith("/")) continue;
    out[key.replace(/^\.\//, "")] = await file.text();
  }
  return out;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function startServer(opts: { confined?: boolean; noDownloader?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flmux-download-route-"));
  tempDirs.push(root);
  if (opts.confined) mkdirSync(join(root, "data"), { recursive: true });
  const policy: ExtensionFsPolicy = opts.confined
    ? { unconfined: false, binds: [{ virtual: "/w/data", realPath: join(root, "data"), mode: "ro" }] }
    : { unconfined: true, binds: [] };
  const downloader = createFsDownloader({ policy, projectDir: root });
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
    resolveFsDownloader: opts.noDownloader ? undefined : () => downloader
  });
  return { server, root };
}

const downloadUrl = (origin: string, path: string) => `${origin}/api/fs/download?path=${encodeURIComponent(path)}`;

describe("/api/fs/download route", () => {
  it("downloads a file with attachment disposition", async () => {
    const { server, root } = startServer();
    try {
      writeFileSync(join(root, "hello.bin"), new Uint8Array([1, 2, 3, 4, 5]));
      const res = await fetch(downloadUrl(server.origin, "/hello.bin"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain('attachment; filename="hello.bin"');
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    } finally {
      server.stop();
    }
  });

  it("streams a folder as gzipped tar of its contents", async () => {
    const { server, root } = startServer();
    try {
      mkdirSync(join(root, "proj", "src"), { recursive: true });
      writeFileSync(join(root, "proj", "readme.md"), "hi");
      writeFileSync(join(root, "proj", "src", "a.ts"), "export {}");
      const res = await fetch(downloadUrl(server.origin, "/proj"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("content-disposition")).toContain('filename="proj.tar.gz"');
      const entries = await tarGzEntries(res);
      expect(entries["readme.md"]).toBe("hi");
      expect(entries["src/a.ts"]).toBe("export {}");
    } finally {
      server.stop();
    }
  });

  it("downloads a non-ASCII filename via RFC 5987 filename*", async () => {
    const { server, root } = startServer();
    try {
      writeFileSync(join(root, "한글파일.txt"), "x");
      const res = await fetch(downloadUrl(server.origin, "/한글파일.txt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(
        `filename*=UTF-8''${encodeURIComponent("한글파일.txt")}`
      );
    } finally {
      server.stop();
    }
  });

  it("serves a confined ro bind and zips its root under the bind leaf name", async () => {
    const { server, root } = startServer({ confined: true });
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "data", "x.txt"), "ro-ok");
      const file = await fetch(downloadUrl(server.origin, "/w/data/x.txt"));
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("ro-ok");
      const archive = await fetch(downloadUrl(server.origin, "/w/data"));
      expect((await tarGzEntries(archive))["x.txt"]).toBe("ro-ok");
    } finally {
      server.stop();
    }
  });

  it("rejects traversal outside a bind", async () => {
    const { server, root } = startServer({ confined: true });
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "secret.txt"), "no");
      for (const path of ["/w/data/../secret.txt", "/secret.txt", "/w/../secret.txt"]) {
        const res = await fetch(downloadUrl(server.origin, path));
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    } finally {
      server.stop();
    }
  });

  it("404s for a missing path and 400s for a non-rooted path", async () => {
    const { server } = startServer();
    try {
      expect((await fetch(downloadUrl(server.origin, "/nope.txt"))).status).toBe(404);
      expect((await fetch(downloadUrl(server.origin, "relative.txt"))).status).toBe(400);
    } finally {
      server.stop();
    }
  });

  it("404s when no downloader is configured (desktop)", async () => {
    const { server, root } = startServer({ noDownloader: true });
    try {
      writeFileSync(join(root, "hello.txt"), "x");
      expect((await fetch(downloadUrl(server.origin, "/hello.txt"))).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

describe("attachmentDisposition", () => {
  it("percent-encodes RFC 5987 special chars in filename* (no raw '()* )", () => {
    const d = attachmentDisposition("a'b(c)*!.txt");
    const ext = d.split("filename*=UTF-8''")[1]!;
    expect(ext).not.toMatch(/['()*!]/);
    expect(ext).toBe("a%27b%28c%29%2A%21.txt");
  });

  it("keeps an ASCII fallback and a UTF-8 filename* for non-ASCII names", () => {
    const d = attachmentDisposition("보고서.pdf");
    expect(d).toContain('filename="___.pdf"');
    expect(d).toContain(`filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`);
  });

  it("neutralizes quotes/backslashes in the ASCII fallback (no header break)", () => {
    const d = attachmentDisposition('a"b\\c.txt');
    expect(d).toContain('filename="a_b_c.txt"');
  });
});
