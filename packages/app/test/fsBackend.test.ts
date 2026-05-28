import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellModel, type PathCallResult } from "@flmux/core/shell";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { createFsBackend } from "../src/main/fsBackend";
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
    const { model } = confinedFixture();

    expect(value<{ entries: Array<{ name: string; kind: string }> }>(await model.pathCall("/fs/list", { path: "/" }))).toEqual({
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
    expect(listed.entries).toEqual([
      { name: "nested", kind: "dir", mtimeMs: expect.any(Number) },
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

  it("does not expose write through /fs, including rw binds", async () => {
    const { model } = confinedFixture();

    expect(await model.pathCall("/fs/write", { path: "/w/rw/rw.txt", content: "x" })).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
    });
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
