import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { createFsUploader, type FsUploader } from "../src/main/fsBackend";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function fixture(): { uploader: FsUploader; rw: string; ro: string; staging: string } {
  const root = mkdtempSync(join(tmpdir(), "flmux-uploader-"));
  tempRoots.push(root);
  const projectDir = join(root, "project");
  const ro = join(root, "ro");
  const rw = join(root, "rw");
  const staging = join(root, "staging", "user");
  mkdirSync(projectDir);
  mkdirSync(ro);
  mkdirSync(rw);
  const policy: ExtensionFsPolicy = {
    unconfined: false,
    binds: [
      { realPath: ro, mode: "ro", virtual: "/w/ro" },
      { realPath: rw, mode: "rw", virtual: "/w/rw" }
    ]
  };
  return { uploader: createFsUploader({ policy, projectDir, stagingDir: staging }), rw, ro, staging };
}

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}

const MAX = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
let idSeq = 0;
function opts(o: Partial<Parameters<FsUploader["upload"]>[2]> = {}): Parameters<FsUploader["upload"]>[2] {
  return {
    uploadId: `testid${(idSeq++).toString().padStart(4, "0")}`,
    offset: 0,
    final: true,
    overwrite: false,
    maxBytes: MAX,
    ...o
  };
}

function stagingFiles(staging: string): string[] {
  try {
    return readdirSync(staging);
  } catch {
    return [];
  }
}

describe("createFsUploader", () => {
  it("streams a file into a rw bind, auto-creating parent dirs", async () => {
    const { uploader, rw, staging } = fixture();
    const r = await uploader.upload(
      "/w/rw/a/b/c.txt",
      bytes("hello ", "world"),
      opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX })
    );
    expect(r).toEqual({ size: 11, committed: true });
    expect(readFileSync(join(rw, "a", "b", "c.txt"), "utf8")).toBe("hello world");
    expect(stagingFiles(staging)).toHaveLength(0);
  });

  it("handles binary bytes", async () => {
    const { uploader, rw } = fixture();
    async function* bin(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([0, 1, 2, 255, 254]);
    }
    await uploader.upload("/w/rw/blob.bin", bin(), opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX }));
    expect([...readFileSync(join(rw, "blob.bin"))]).toEqual([0, 1, 2, 255, 254]);
  });

  it("rejects writes into a ro bind", async () => {
    const { uploader } = fixture();
    await expect(
      uploader.upload("/w/ro/x.txt", bytes("x"), opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX }))
    ).rejects.toMatchObject({ code: "NOT_WRITABLE" });
  });

  it("no-clobber by default; overwrite=true replaces", async () => {
    const { uploader, rw } = fixture();
    writeFileSync(join(rw, "exists.txt"), "old");
    await expect(
      uploader.upload(
        "/w/rw/exists.txt",
        bytes("new"),
        opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX })
      )
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await uploader.upload(
      "/w/rw/exists.txt",
      bytes("new"),
      opts({ offset: 0, final: true, overwrite: true, maxBytes: MAX })
    );
    expect(readFileSync(join(rw, "exists.txt"), "utf8")).toBe("new");
  });

  it("enforces the per-file byte cap and drops the partial", async () => {
    const { uploader, rw, staging } = fixture();
    await expect(
      uploader.upload("/w/rw/big.txt", bytes("abcdef"), opts({ offset: 0, final: true, overwrite: false, maxBytes: 3 }))
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
    expect(existsSync(join(rw, "big.txt"))).toBe(false);
    expect(stagingFiles(staging)).toHaveLength(0);
  });

  it("validates leaf names — rejects NTFS ADS / reserved / traversal", async () => {
    const { uploader } = fixture();
    for (const bad of ["/w/rw/foo.txt:ads", "/w/rw/con", "/w/rw/trailing.", "/w/rw/a/../escape.txt"]) {
      await expect(
        uploader.upload(bad, bytes("x"), opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX }))
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
    }
  });

  it("refuses to follow a symlinked parent dir", async () => {
    const { uploader, rw, ro } = fixture();
    try {
      symlinkSync(ro, join(rw, "link"), "dir");
    } catch {
      return; // symlink unsupported on this host — skip
    }
    await expect(
      uploader.upload("/w/rw/link/x.txt", bytes("x"), opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX }))
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("sequencing: a later chunk's offset must equal the current staging size", async () => {
    const { uploader, rw } = fixture();
    const uploadId = "seqid0001";
    await uploader.upload("/w/rw/seq.txt", bytes("abc"), opts({ uploadId, offset: 0, final: false }));
    await expect(uploader.upload("/w/rw/seq.txt", bytes("X"), opts({ uploadId, offset: 99 }))).rejects.toMatchObject({
      code: "INVALID_VALUE"
    });
    await uploader.upload("/w/rw/seq.txt", bytes("def"), opts({ uploadId, offset: 3 }));
    expect(readFileSync(join(rw, "seq.txt"), "utf8")).toBe("abcdef");
  });

  it("chunked: non-final chunks stay in staging, final commits — target never shows a partial", async () => {
    const { uploader, rw, staging } = fixture();
    const uploadId = "chunkid01";
    expect(
      await uploader.upload("/w/rw/chunked.txt", bytes("aaa"), opts({ uploadId, offset: 0, final: false }))
    ).toEqual({
      size: 3,
      committed: false
    });
    expect(stagingFiles(staging)).toHaveLength(1);
    expect(existsSync(join(rw, "chunked.txt"))).toBe(false);
    expect(
      await uploader.upload("/w/rw/chunked.txt", bytes("bbb"), opts({ uploadId, offset: 3, final: true }))
    ).toEqual({
      size: 6,
      committed: true
    });
    expect(readFileSync(join(rw, "chunked.txt"), "utf8")).toBe("aaabbb");
    expect(stagingFiles(staging)).toHaveLength(0);
  });

  it("commits a 0-byte file (empty body)", async () => {
    const { uploader, rw } = fixture();
    expect(await uploader.upload("/w/rw/empty.txt", bytes(), opts())).toEqual({ size: 0, committed: true });
    expect(readFileSync(join(rw, "empty.txt"), "utf8")).toBe("");
  });

  it("rejects an invalid uploadId", async () => {
    const { uploader } = fixture();
    for (const bad of ["", "../escape", "a", "has/slash", "a".repeat(65)]) {
      await expect(uploader.upload("/w/rw/x.txt", bytes("x"), opts({ uploadId: bad }))).rejects.toMatchObject({
        code: "INVALID_VALUE"
      });
    }
  });

  it("isolates concurrent uploads to one path — distinct ids, no byte-mixing", async () => {
    const { uploader, rw } = fixture();
    await uploader.upload("/w/rw/race.txt", bytes("AAA"), opts({ uploadId: "raceida01", offset: 0, final: false }));
    await uploader.upload("/w/rw/race.txt", bytes("BBB"), opts({ uploadId: "raceidb02", offset: 0, final: false }));
    await uploader.upload("/w/rw/race.txt", bytes("aaa"), opts({ uploadId: "raceida01", offset: 3, final: true }));
    await expect(
      uploader.upload("/w/rw/race.txt", bytes("bbb"), opts({ uploadId: "raceidb02", offset: 3, final: true }))
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(readFileSync(join(rw, "race.txt"), "utf8")).toBe("AAAaaa");
  });

  it("re-pins to the target path — a chunk for a different path can't reach the staged bytes", async () => {
    const { uploader } = fixture();
    const uploadId = "pinid0001";
    await uploader.upload("/w/rw/a.txt", bytes("aaa"), opts({ uploadId, offset: 0, final: false }));
    await expect(
      uploader.upload("/w/rw/b.txt", bytes("bbb"), opts({ uploadId, offset: 3, final: true }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects resuming a staging file already past the TTL", async () => {
    const { uploader, staging } = fixture();
    const uploadId = "ttlid0001";
    await uploader.upload("/w/rw/slow.txt", bytes("aaa"), opts({ uploadId, offset: 0, final: false }));
    const file = join(staging, readdirSync(staging)[0]!);
    const old = (Date.now() - 2 * HOUR_MS) / 1000;
    utimesSync(file, old, old);
    await expect(
      uploader.upload("/w/rw/slow.txt", bytes("bbb"), opts({ uploadId, offset: 3, final: true }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sweeps a stale staging file on a new upload (GC), without touching a fresh one", async () => {
    const { uploader, rw, staging } = fixture();
    mkdirSync(staging, { recursive: true });
    const stale = join(staging, `${"0".repeat(32)}.staleupload01`);
    writeFileSync(stale, "STALE-GARBAGE");
    const old = (Date.now() - 2 * HOUR_MS) / 1000;
    utimesSync(stale, old, old);
    await uploader.upload("/w/rw/fresh.txt", bytes("fresh"), opts());
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(rw, "fresh.txt"), "utf8")).toBe("fresh");
  });

  it("mkdirp rejects a path segment that exists as a file", async () => {
    const { uploader, rw } = fixture();
    writeFileSync(join(rw, "afile"), "x");
    await expect(
      uploader.upload(
        "/w/rw/afile/child.txt",
        bytes("x"),
        opts({ offset: 0, final: true, overwrite: false, maxBytes: MAX })
      )
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });
});
