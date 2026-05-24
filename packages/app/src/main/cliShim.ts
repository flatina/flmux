import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExtensionManifestCommand } from "@flmux/extension-api";
import { isCompiledBinary } from "../shared/buildTarget";

const FLMUX_SHIM_NAME = "flmux";

// Built-in subcommands an extension shim must not shadow.
const RESERVED_SHIM_NAMES: ReadonlySet<string> = new Set([
  FLMUX_SHIM_NAME,
  "clients",
  "get",
  "ls",
  "ls-each-get",
  "set",
  "call",
  "tokens"
]);

export interface CliShimResult {
  ok: boolean;
  reason?: "no-cli-entry" | "no-bun-command";
  entry?: string;
  bunCommand?: string;
}

interface EnsureOptions {
  binDir: string;
  baseDir: string;
  fileExists?: (path: string) => boolean;
  resolveBunCommand?: () => string | null;
}

// Idempotent. Writes posix + .cmd shims so terminal panes' PATH can resolve `flmux`.
export function ensureFlmuxCliShim(options: EnsureOptions): CliShimResult {
  const fileExists = options.fileExists ?? existsSync;
  const resolveBunCmd = options.resolveBunCommand ?? (() => Bun.which("bun"));

  if (isCompiledBinary) {
    mkdirSync(options.binDir, { recursive: true });
    writeCompiledShimPair(options.binDir, FLMUX_SHIM_NAME, "cli", []);
    return { ok: true, entry: process.execPath, bunCommand: process.execPath };
  }

  const entry = resolveCliEntry(options.baseDir, fileExists);
  if (!entry) return { ok: false, reason: "no-cli-entry" };

  const bunCommand = resolveBunCmd();
  if (!bunCommand) return { ok: false, reason: "no-bun-command", entry };

  mkdirSync(options.binDir, { recursive: true });
  writeShimPair(options.binDir, FLMUX_SHIM_NAME, bunCommand, [entry]);

  return { ok: true, entry, bunCommand };
}


export interface ExtensionShimSource {
  extensionId: string;
  commands: readonly ExtensionManifestCommand[] | undefined;
}

export interface ExtensionShimsResult {
  written: readonly string[];
  skipped: readonly { name: string; extensionId: string; reason: "reserved" | "duplicate" }[];
}

// Per extension command (manifest `shim` opt-in): forwards to `flmux <commandId>`. Prunes stale.
export function ensureExtensionCliShims(options: {
  binDir: string;
  bunCommand: string;
  cliEntry: string;
  extensions: readonly ExtensionShimSource[];
}): ExtensionShimsResult {
  mkdirSync(options.binDir, { recursive: true });

  const written: string[] = [];
  const skipped: { name: string; extensionId: string; reason: "reserved" | "duplicate" }[] = [];
  const claimed = new Set<string>();

  const compiled = isCompiledBinary;
  for (const ext of options.extensions) {
    for (const command of ext.commands ?? []) {
      if (!command.shim) continue;
      if (RESERVED_SHIM_NAMES.has(command.shim)) {
        skipped.push({ name: command.shim, extensionId: ext.extensionId, reason: "reserved" });
        continue;
      }
      if (claimed.has(command.shim)) {
        skipped.push({ name: command.shim, extensionId: ext.extensionId, reason: "duplicate" });
        continue;
      }
      claimed.add(command.shim);
      if (compiled) {
        writeCompiledShimPair(options.binDir, command.shim, "cli", [command.id]);
      } else {
        writeShimPair(options.binDir, command.shim, options.bunCommand, [options.cliEntry, command.id]);
      }
      written.push(command.shim);
    }
  }

  pruneStaleShims(options.binDir, new Set([FLMUX_SHIM_NAME, ...written]));

  return { written, skipped };
}

function resolveCliEntry(baseDir: string, fileExists: (path: string) => boolean): string | undefined {
  // Candidate order mirrors `resolveAppPtydEntry`: source first (dev), then
  // the bundled sibling next to `main.js` (packaged build output).
  const sourceEntry = resolve(baseDir, "cli.ts");
  if (fileExists(sourceEntry)) return sourceEntry;

  const packagedEntry = resolve(baseDir, "cli.js");
  if (fileExists(packagedEntry)) return packagedEntry;

  return undefined;
}

function writeShimPair(binDir: string, name: string, bunCommand: string, leadingArgs: readonly string[]): void {
  writeIfChanged(join(binDir, name), renderPosixShim(bunCommand, leadingArgs), 0o755);
  writeIfChanged(join(binDir, `${name}.cmd`), renderCmdShim(bunCommand, leadingArgs));
}

function writeCompiledShimPair(binDir: string, name: string, mode: "cli", leadingArgs: readonly string[]): void {
  const exe = process.execPath;
  const posix = `#!/usr/bin/env sh\nFLMUX_INTERNAL_MODE=${mode} exec ${quotePosix(exe)} ${leadingArgs.map(quotePosix).join(" ")} "$@"\n`;
  const cmd = `@echo off\r\nset "FLMUX_INTERNAL_MODE=${mode}"\r\n${quoteCmd(exe)} ${leadingArgs.map(quoteCmd).join(" ")} %*\r\n`;
  writeIfChanged(join(binDir, name), posix, 0o755);
  writeIfChanged(join(binDir, `${name}.cmd`), cmd);
}

function pruneStaleShims(binDir: string, expectedNames: ReadonlySet<string>): void {
  if (!existsSync(binDir)) return;
  const expectedFiles = new Set<string>();
  for (const name of expectedNames) {
    expectedFiles.add(name);
    expectedFiles.add(`${name}.cmd`);
  }
  for (const entry of readdirSync(binDir)) {
    if (expectedFiles.has(entry)) continue;
    try {
      unlinkSync(join(binDir, entry));
    } catch {
      // Ignore — another process may have removed it, or permissions blocked.
    }
  }
}

function renderPosixShim(bunCommand: string, leadingArgs: readonly string[]): string {
  const head = [bunCommand, ...leadingArgs].map(quotePosix).join(" ");
  return `#!/usr/bin/env sh\nexec ${head} "$@"\n`;
}

function renderCmdShim(bunCommand: string, leadingArgs: readonly string[]): string {
  const head = [bunCommand, ...leadingArgs].map(quoteCmd).join(" ");
  return `@echo off\r\n${head} %*\r\n`;
}

function quotePosix(value: string): string {
  // Single-quoted preserves Windows backslashes; double would treat `\` as escape.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteCmd(value: string): string {
  // cmd.exe has no `"` escape; embedded quotes in paths are rare — strip.
  return `"${value.replace(/"/g, "")}"`;
}

function writeIfChanged(path: string, content: string, mode?: number): void {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) return;
  }
  writeFileSync(path, content, "utf8");
  if (mode !== undefined && process.platform !== "win32") {
    chmodSync(path, mode);
  }
}
