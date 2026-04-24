import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureExtensionCliShims, ensureFlmuxCliShim, type ExtensionShimSource } from "../src/main/cliShim";

describe("ensureFlmuxCliShim", () => {
  let work: string;
  let binDir: string;
  let baseDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "flmux-cli-shim-"));
    binDir = join(work, "bin");
    baseDir = join(work, "base");
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("prefers cli.ts when both the source and bundled entry exist", () => {
    const sourceEntry = join(baseDir, "cli.ts");
    const packagedEntry = join(baseDir, "cli.js");
    writeFileSync(sourceEntry, "// source", "utf8");
    writeFileSync(packagedEntry, "// packaged", "utf8");

    const result = ensureFlmuxCliShim({
      binDir,
      baseDir,
      resolveBunCommand: () => "/usr/bin/bun"
    });

    expect(result.ok).toBe(true);
    expect(result.entry).toBe(resolve(sourceEntry));
    expect(result.bunCommand).toBe("/usr/bin/bun");
  });

  it("falls back to cli.js when only the packaged entry exists", () => {
    const packagedEntry = join(baseDir, "cli.js");
    writeFileSync(packagedEntry, "// packaged", "utf8");

    const result = ensureFlmuxCliShim({
      binDir,
      baseDir,
      resolveBunCommand: () => "/usr/bin/bun"
    });

    expect(result.ok).toBe(true);
    expect(result.entry).toBe(resolve(packagedEntry));
  });

  it("writes both posix and cmd shims with shell-quoted bun + entry", () => {
    const sourceEntry = join(baseDir, "cli.ts");
    writeFileSync(sourceEntry, "// source", "utf8");

    ensureFlmuxCliShim({
      binDir,
      baseDir,
      resolveBunCommand: () => "/usr/bin/bun"
    });

    const posix = readFileSync(join(binDir, "flmux"), "utf8");
    expect(posix.startsWith("#!/usr/bin/env sh\n")).toBe(true);
    expect(posix).toContain("exec '/usr/bin/bun'");
    expect(posix).toContain('"$@"');
    expect(posix).toContain(resolve(sourceEntry));

    const cmd = readFileSync(join(binDir, "flmux.cmd"), "utf8");
    expect(cmd.startsWith("@echo off\r\n")).toBe(true);
    expect(cmd).toContain('"/usr/bin/bun"');
    expect(cmd).toContain("%*");
  });

  it("is idempotent — second call with identical inputs does not rewrite content", () => {
    const sourceEntry = join(baseDir, "cli.ts");
    writeFileSync(sourceEntry, "// source", "utf8");

    ensureFlmuxCliShim({ binDir, baseDir, resolveBunCommand: () => "/usr/bin/bun" });
    const firstPosix = readFileSync(join(binDir, "flmux"), "utf8");

    ensureFlmuxCliShim({ binDir, baseDir, resolveBunCommand: () => "/usr/bin/bun" });
    const secondPosix = readFileSync(join(binDir, "flmux"), "utf8");

    expect(secondPosix).toBe(firstPosix);
  });

  it("rewrites the shim when bun path changes", () => {
    const sourceEntry = join(baseDir, "cli.ts");
    writeFileSync(sourceEntry, "// source", "utf8");

    ensureFlmuxCliShim({ binDir, baseDir, resolveBunCommand: () => "/opt/old/bun" });
    ensureFlmuxCliShim({ binDir, baseDir, resolveBunCommand: () => "/opt/new/bun" });

    const posix = readFileSync(join(binDir, "flmux"), "utf8");
    expect(posix).toContain("/opt/new/bun");
    expect(posix).not.toContain("/opt/old/bun");
  });

  it("skips with no-cli-entry when neither cli.ts nor cli.js exists", () => {
    const result = ensureFlmuxCliShim({
      binDir,
      baseDir,
      resolveBunCommand: () => "/usr/bin/bun"
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-cli-entry");
    expect(existsSync(join(binDir, "flmux"))).toBe(false);
  });

  it("skips with empty reason when a command has no shim field", () => {
    const extensions: ExtensionShimSource[] = [
      { extensionId: "sample.cowsay", commands: [{ id: "cowsay", description: "open" }] }
    ];

    const result = ensureExtensionCliShims({
      binDir,
      bunCommand: "/usr/bin/bun",
      cliEntry: "/install/cli.ts",
      extensions
    });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(binDir, "cowsay"))).toBe(false);
  });

  it("writes opt-in extension shim forwarding flmux <commandId>", () => {
    const extensions: ExtensionShimSource[] = [
      {
        extensionId: "sample.cowsay",
        commands: [{ id: "cowsay", description: "open", shim: "cowsay" }]
      }
    ];

    const result = ensureExtensionCliShims({
      binDir,
      bunCommand: "/usr/bin/bun",
      cliEntry: "/install/cli.ts",
      extensions
    });

    expect(result.written).toEqual(["cowsay"]);
    const posix = readFileSync(join(binDir, "cowsay"), "utf8");
    expect(posix).toContain("exec '/usr/bin/bun' '/install/cli.ts' 'cowsay' \"$@\"");
    const cmd = readFileSync(join(binDir, "cowsay.cmd"), "utf8");
    expect(cmd).toContain('"/usr/bin/bun" "/install/cli.ts" "cowsay" %*');
  });

  it("skips shim names that collide with flmux built-ins", () => {
    const extensions: ExtensionShimSource[] = [
      {
        extensionId: "evil.get",
        commands: [{ id: "evil", shim: "get" }]
      }
    ];

    const result = ensureExtensionCliShims({
      binDir,
      bunCommand: "/usr/bin/bun",
      cliEntry: "/install/cli.ts",
      extensions
    });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ name: "get", extensionId: "evil.get", reason: "reserved" }]);
    expect(existsSync(join(binDir, "get"))).toBe(false);
  });

  it("skips duplicate shim names across extensions, keeping the first", () => {
    const extensions: ExtensionShimSource[] = [
      { extensionId: "a", commands: [{ id: "cmd", shim: "dup" }] },
      { extensionId: "b", commands: [{ id: "other", shim: "dup" }] }
    ];

    const result = ensureExtensionCliShims({
      binDir,
      bunCommand: "/usr/bin/bun",
      cliEntry: "/install/cli.ts",
      extensions
    });

    expect(result.written).toEqual(["dup"]);
    expect(result.skipped).toEqual([{ name: "dup", extensionId: "b", reason: "duplicate" }]);
    const posix = readFileSync(join(binDir, "dup"), "utf8");
    expect(posix).toContain("'cmd'");
  });

  it("prunes stale shim files that no longer map to any extension command", () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "flmux"), "keep-me", "utf8");
    writeFileSync(join(binDir, "flmux.cmd"), "keep-me", "utf8");
    writeFileSync(join(binDir, "old-shim"), "stale", "utf8");
    writeFileSync(join(binDir, "old-shim.cmd"), "stale", "utf8");

    ensureExtensionCliShims({
      binDir,
      bunCommand: "/usr/bin/bun",
      cliEntry: "/install/cli.ts",
      extensions: []
    });

    expect(existsSync(join(binDir, "flmux"))).toBe(true);
    expect(existsSync(join(binDir, "flmux.cmd"))).toBe(true);
    expect(existsSync(join(binDir, "old-shim"))).toBe(false);
    expect(existsSync(join(binDir, "old-shim.cmd"))).toBe(false);
  });

  it("skips with no-bun-command when Bun.which returns null", () => {
    const sourceEntry = join(baseDir, "cli.ts");
    writeFileSync(sourceEntry, "// source", "utf8");

    const result = ensureFlmuxCliShim({
      binDir,
      baseDir,
      resolveBunCommand: () => null
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-bun-command");
    expect(existsSync(join(binDir, "flmux"))).toBe(false);
  });
});
