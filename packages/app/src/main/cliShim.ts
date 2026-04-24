import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExtensionManifestCommand } from "@flmux/extension-api";

const FLMUX_SHIM_NAME = "flmux";

/** Root-level flmux CLI subcommands that must not be shadowed by an extension
 *  shim on PATH. Collisions would silently bypass the citty root dispatch. */
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
  /** Reason populated only when `ok` is false. */
  reason?: "no-cli-entry" | "no-bun-command";
  /** Absolute path to the resolved CLI entry (TS source in dev, bundled JS in
   *  packaged). Undefined when skipped. */
  entry?: string;
  /** Absolute path to the bun runtime the shim invokes. */
  bunCommand?: string;
}

interface EnsureOptions {
  binDir: string;
  /** Directory containing `main.ts` (dev) or `main.js` (packaged). Used to
   *  locate the CLI entry next to it — same layout assumption as
   *  `resolveAppPtydEntry` in ptyd/launch.ts. */
  baseDir: string;
  /** Testing seam: override existence check. */
  fileExists?: (path: string) => boolean;
  /** Testing seam: override `Bun.which("bun")`. */
  resolveBunCommand?: () => string | null;
}

/**
 * Write `<binDir>/flmux` (posix) and `<binDir>/flmux.cmd` (windows) pointing
 * at the flmux CLI entry resolved from this install's layout. Prepended to
 * terminal PATH in `createTerminalEnv` so panes can invoke `flmux <cmd>`
 * against the version that owns their rootDir.
 *
 * Idempotent — only writes when content differs, so boot-time calls are cheap.
 * Skips with `ok:false` when either the CLI entry or the bun runtime can't
 * be resolved; callers log and continue (PATH entry pointing to an empty
 * dir is harmless).
 */
export function ensureFlmuxCliShim(options: EnsureOptions): CliShimResult {
  const fileExists = options.fileExists ?? existsSync;
  const resolveBunCmd = options.resolveBunCommand ?? (() => Bun.which("bun"));

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
  /** Shim names written this pass (excluding `flmux` itself). */
  written: readonly string[];
  /** Shim names skipped with the reason — surfaced to the operator as
   *  warnings so collisions are visible instead of silently dropped. */
  skipped: readonly { name: string; extensionId: string; reason: "reserved" | "duplicate" }[];
}

/** Write one PATH shim per extension command that opts in via its manifest
 *  `shim` field. Each shim forwards to `flmux <commandId> "$@"` so citty root
 *  dispatch stays the single entry point. Stale files in `binDir` (old shims
 *  from renamed / uninstalled extensions) are removed. */
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
      writeShimPair(options.binDir, command.shim, options.bunCommand, [options.cliEntry, command.id]);
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

/** Remove files in `binDir` that aren't part of the current shim universe so
 *  renamed or uninstalled extensions don't leave dangling commands on PATH.
 *  `binDir` is owned by flmux — other tools have no reason to write here. */
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
  // Single quotes preserve Windows path backslashes verbatim — double quotes
  // would let the shell treat `\` as an escape character on some paths.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteCmd(value: string): string {
  // cmd.exe has no escape for embedded `"`; paths with quotes are extremely
  // rare and not worth handling beyond a best-effort strip.
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
