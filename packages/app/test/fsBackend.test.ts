import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellModel, type PathCallResult } from "@flmux/core/shell";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { createFsBackend, createFsPathMapper } from "../src/main/fsBackend";
import { TestShellModelHost } from "./support/testShellModelHost";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "flmux-fs-backend-"));
  tempRoots.push(root);
  return root;
}

function createModel(options: { projectDir: string; policy: ExtensionFsPolicy }) {
  const host = new TestShellModelHost();
  return createShellModel({
    host,
    terminal: host.createTerminalDelegate(),
    fs: createFsBackend(options)
  });
}

function confinedFixture() {
  const root = tempRoot();
  const projectDir = join(root, "project");
  const ro = join(root, "ro");
  const rw = join(root, "rw");
  const nested = join(rw, "nested");
  const outside = join(root, "outside");
  mkdirSync(projectDir);
  mkdirSync(ro);
  mkdirSync(rw);
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(ro, "ro.txt"), "readonly");
  writeFileSync(join(rw, "rw.txt"), "writeable");
  writeFileSync(join(nested, "note.txt"), "nested note");
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  const policy: ExtensionFsPolicy = {
    unconfined: false,
    binds: [
      { realPath: ro, mode: "ro", virtual: "/w/ro" },
      { realPath: rw, mode: "rw", virtual: "/w/rw" }
    ]
  };
  return { root, projectDir, ro, rw, outside, model: createModel({ projectDir, policy }) };
}

function value<T>(result: PathCallResult): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.code}: ${result.error}`);
  }
  return result.value as T;
}

describe("/fs ShellModelAPI backend", () => {
  it("lists synthetic roots and reads/stats files from ro and rw binds", async () => {
    const { model, rw } = confinedFixture();
    writeFileSync(join(rw, "a.txt"), "x");

    expect(
      value<{ entries: Array<{ name: string; kind: string }> }>(await model.pathCall("/fs/list", { path: "/" }))
    ).toEqual({
      entries: [{ name: "w", kind: "dir" }]
    });
    expect(
      value<{ entries: Array<{ name: string; kind: string }> }>(await model.pathCall("/fs/list", { path: "/w" }))
    ).toEqual({
      entries: [
        { name: "ro", kind: "dir" },
        { name: "rw", kind: "dir" }
      ]
    });

    expect(await model.pathCall("/fs/read", { path: "/w/ro/ro.txt" })).toEqual({
      ok: true,
      value: { content: "readonly", truncated: false }
    });
    expect(await model.pathCall("/fs/read", { path: "/w/rw/rw.txt", maxBytes: 5 })).toEqual({
      ok: true,
      value: { content: "write", truncated: true }
    });

    const listed = value<{ entries: Array<{ name: string; kind: string; size?: number; mtimeMs?: number }> }>(
      await model.pathCall("/fs/list", { path: "/w/rw" })
    );
    // Dirs first, then files by name ("a.txt" < "nested" alphabetically).
    expect(listed.entries).toEqual([
      { name: "nested", kind: "dir", mtimeMs: expect.any(Number) },
      { name: "a.txt", kind: "file", size: 1, mtimeMs: expect.any(Number) },
      { name: "rw.txt", kind: "file", size: 9, mtimeMs: expect.any(Number) }
    ]);

    expect(await model.pathCall("/fs/stat", { path: "/w/ro/ro.txt" })).toMatchObject({
      ok: true,
      value: { kind: "file", size: 8, mtimeMs: expect.any(Number) }
    });
    expect(await model.pathCall("/fs/stat", { path: "/w/rw/nested" })).toMatchObject({
      ok: true,
      value: { kind: "dir", mtimeMs: expect.any(Number) }
    });
  });

  it("exposes write as a rw-gated overwrite through /fs", async () => {
    const { model } = confinedFixture();

    expect(await model.pathCall("/fs/write", { path: "/w/rw/rw.txt", content: "x" })).toEqual({
      ok: true,
      value: { bytesWritten: 1 }
    });
    expect(await model.pathCall("/fs/read", { path: "/w/rw/rw.txt" })).toEqual({
      ok: true,
      value: { content: "x", truncated: false }
    });
    expect(await model.pathCall("/fs/write", { path: "/w/ro/ro.txt", content: "x" })).toMatchObject({
      ok: false,
      code: "NOT_WRITABLE"
    });
  });

  it("writes binary content (Uint8Array) byte-exact through /fs", async () => {
    const { model, rw } = confinedFixture();
    // PNG signature + NUL/0xFF — bytes a UTF-8 round-trip would corrupt.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1a, 0x0a]);
    // A non-zero-offset subarray view of a larger buffer — the production shape
    // (msgpackr decodes `bin` as a view into the message buffer). Sentinels on
    // both ends catch a writer that ignores byteOffset/byteLength.
    const framed = new Uint8Array([0xaa, 0xbb, ...bytes, 0xcc, 0xdd]);
    const content = framed.subarray(2, 2 + bytes.length);

    expect(await model.pathCall("/fs/write", { path: "/w/rw/img.png", content })).toEqual({
      ok: true,
      value: { bytesWritten: bytes.length }
    });
    // Read raw from disk — proves byte fidelity (the model read path is utf8-only).
    expect(new Uint8Array(readFileSync(join(rw, "img.png")))).toEqual(bytes);
  });

  it("rejects parent segments and NUL bytes before traversal", async () => {
    const { model } = confinedFixture();

    expect(await model.pathCall("/fs/read", { path: "/w/rw/../ro/ro.txt" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
    expect(await model.pathCall("/fs/stat", { path: "/w/rw/a\0b" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
  });

  it("treats unconfined /fs paths as virtual (no native-absolute escape)", async () => {
    const root = tempRoot();
    const projectDir = join(root, "project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "inside.txt"), "inside");
    const model = createModel({ projectDir, policy: { unconfined: true, binds: [] } });

    // Virtual root-relative paths (leading "/" or relative) resolve under projectDir.
    expect(await model.pathCall("/fs/read", { path: "/inside.txt" })).toEqual({
      ok: true,
      value: { content: "inside", truncated: false }
    });
    expect(await model.pathCall("/fs/read", { path: "inside.txt" })).toEqual({
      ok: true,
      value: { content: "inside", truncated: false }
    });
    // Windows drive paths (Cx:\…/Cx:foo) are rejected outright — no host-root escape vector.
    expect(await model.pathCall("/fs/read", { path: "C:\\evil.txt" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
  });

  it("unconfined toVirtual round-trips (projectRoot-relative, not absolute)", () => {
    const root = realpathSync(tempRoot()); // canonical base so non-existent lexical fallback is exact
    const projectDir = join(root, "project");
    mkdirSync(join(projectDir, "a", "b"), { recursive: true });
    const file = join(projectDir, "a", "b", "x.png");
    writeFileSync(file, "x");
    const mapper = createFsPathMapper({ projectDir, policy: { unconfined: true, binds: [] } });

    // Relative `/<rel>` (not absolute canon) → toReal re-roots under projectDir → identity.
    const v = mapper.toVirtual(file);
    expect(v).toBe("/a/b/x.png");
    expect(realpathSync(mapper.toReal(v!, "read").realPath)).toBe(realpathSync(file));
    expect(mapper.toVirtual(projectDir)).toBe("/");
    // Outside projectRoot is unreachable via unconfined /fs → no virtual form.
    expect(mapper.toVirtual(join(root, "outside.txt"))).toBeNull();

    // Non-existent in-project leaf: toVirtual lexical-resolve branch + toReal write branch.
    mkdirSync(join(projectDir, "c"));
    const newV = mapper.toVirtual(join(projectDir, "c", "new.txt"));
    expect(newV).toBe("/c/new.txt");
    expect(mapper.toReal(newV!, "write").realPath).toBe(join(projectDir, "c", "new.txt"));
  });

  it("rejects a planted symlink that points outside a bind", async () => {
    const { model, rw, outside } = confinedFixture();
    symlinkSync(outside, join(rw, "escape"), "junction");

    expect(await model.pathCall("/fs/read", { path: "/w/rw/escape/secret.txt" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
    expect(await model.pathCall("/fs/list", { path: "/w/rw/escape" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
  });

  it("keeps /fs off get/list and maps set to read-only", async () => {
    const { model } = confinedFixture();

    expect(await model.pathGet("/fs")).toEqual({ ok: true, found: false, value: null });
    expect(await model.pathList("/fs")).toEqual({ ok: true, found: false, entries: [] });
    expect(await model.pathSet("/fs/read", "x")).toMatchObject({ ok: false, code: "NOT_WRITABLE" });
  });

  it("returns NOT_FOUND for /fs calls when no backend is installed", async () => {
    const model = new TestShellModelHost().createModel();

    expect(await model.pathCall("/fs/list", { path: "/" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("copies files and trees, allows cross-bind ro→rw, and enforces no-clobber", async () => {
    const { model, rw } = confinedFixture();

    // ro → rw (cross-bind copy is allowed; rename is not).
    expect(await model.pathCall("/fs/copy", { from: "/w/ro/ro.txt", to: "/w/rw/copied.txt" })).toEqual({
      ok: true,
      value: { copied: true, kind: "file" }
    });
    expect(await model.pathCall("/fs/read", { path: "/w/rw/copied.txt" })).toEqual({
      ok: true,
      value: { content: "readonly", truncated: false }
    });

    // No-clobber.
    expect(await model.pathCall("/fs/copy", { from: "/w/rw/rw.txt", to: "/w/rw/copied.txt" })).toMatchObject({
      ok: false,
      code: "ALREADY_EXISTS"
    });

    // Recursive dir copy.
    expect(await model.pathCall("/fs/copy", { from: "/w/rw/nested", to: "/w/rw/nested-copy" })).toEqual({
      ok: true,
      value: { copied: true, kind: "dir" }
    });
    expect(await model.pathCall("/fs/read", { path: "/w/rw/nested-copy/note.txt" })).toEqual({
      ok: true,
      value: { content: "nested note", truncated: false }
    });

    // Dest must be writable.
    expect(await model.pathCall("/fs/copy", { from: "/w/rw/rw.txt", to: "/w/ro/x.txt" })).toMatchObject({
      ok: false,
      code: "NOT_WRITABLE"
    });

    // No copy into own descendant.
    expect(await model.pathCall("/fs/copy", { from: "/w/rw/nested", to: "/w/rw/nested/self" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });

    // Symlink in the source tree is rejected, and the partial dest is rolled back.
    symlinkSync(rw, join(rw, "nested", "link"), "junction");
    expect(await model.pathCall("/fs/copy", { from: "/w/rw/nested", to: "/w/rw/nested-copy-2" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH"
    });
    expect(await model.pathCall("/fs/list", { path: "/w/rw/nested-copy-2" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND"
    });
  });

  it("trims a trailing incomplete UTF-8 sequence on truncated read", async () => {
    const root = tempRoot();
    const projectDir = join(root, "project");
    const rw = join(root, "rw");
    mkdirSync(projectDir);
    mkdirSync(rw);
    // "한" (U+D55C) = ED 95 9C in UTF-8 (3 bytes), then ASCII "a" (1 byte) = 4 bytes total.
    writeFileSync(join(rw, "kor.txt"), "한a", "utf8");
    const model = createModel({
      projectDir,
      policy: { unconfined: false, binds: [{ realPath: rw, mode: "rw", virtual: "/w/rw" }] }
    });
    // maxBytes=2 cuts mid-codepoint → both bytes of the incomplete "한" are trimmed.
    expect(await model.pathCall("/fs/read", { path: "/w/rw/kor.txt", maxBytes: 2 })).toEqual({
      ok: true,
      value: { content: "", truncated: true }
    });
    // maxBytes=3 is exactly "한"; complete sequence kept, "a" still missing → truncated.
    expect(await model.pathCall("/fs/read", { path: "/w/rw/kor.txt", maxBytes: 3 })).toEqual({
      ok: true,
      value: { content: "한", truncated: true }
    });
  });
});
