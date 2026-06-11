import { resolve } from "node:path";
import { parseArgs, type CommandDef } from "citty";
import { resolveInstallLayout } from "./main/flmuxPaths";
import { createExtensionConfigLoader } from "./main/extConfig";
import {
  FLMUX_EXTENSION_COMMAND,
  createFlmuxClient,
  toFlmuxCliFlags,
  type FlmuxCliFlags,
  type FlmuxExtensionCliContext,
  type FlmuxExtensionCommand,
  type ShellClient
} from "@flmux/extension-api/cli";
import {
  discoverConfiguredLocalExtensions,
  resolveConfiguredLocalExtensionsRootDir,
  type DiscoveredLocalExtension
} from "./main/localExtensions";

interface DiscoveredLocalCliCommand {
  commandId: string;
  description?: string;
  extensionId: string;
  extension: DiscoveredLocalExtension;
  cliEntryRelativePath: string;
}

type CliModule = {
  default?: FlmuxExtensionCommand | CommandDef;
};

export interface LoadCliCommandDefOptions {
  /** Resolves the per-extension data dir, mkdir'ing on first call. Returns
   * null if the extension isn't registered (extId is flmux-supplied so this
   * should never happen in practice). */
  resolveExtensionDataDir(extensionId: string): string | null;
}

/**
 * Dynamically import an extension's CLI entry and return a citty `CommandDef`
 * — wrapped from the extension's `defineExtensionCommand(...)` export with
 * flmux-supplied `ctx` (currently `dataDir`) injected. Returns null if the
 * entry or its export is missing/wrong-shape; caller falls back to the
 * built-in subcommands in that case.
 *
 * Data-URL imports (archive-backed extensions) work because CLI entries are
 * contract-bound to zero runtime externals.
 */
export async function loadLocalCliCommandDef(
  command: DiscoveredLocalCliCommand,
  options: LoadCliCommandDefOptions
): Promise<CommandDef | null> {
  const def = await loadRawCliCommand(command.extension);
  if (!def) return null;
  return wrapAsCommandDef(def, command.extensionId, options);
}

// Keyed by entry URL — matches the module import cache.
const rawCliCommandCache = new Map<string, FlmuxExtensionCommand | null>();

// Raw (pre-citty-wrap) def for the in-process invoker; the subprocess path wraps the same def.
export async function loadRawCliCommand(extension: DiscoveredLocalExtension): Promise<FlmuxExtensionCommand | null> {
  if (!extension.cliEntryRelativePath) return null;
  const entryUrl = await extension.resolveEntryImportUrl(extension.cliEntryRelativePath);
  if (!entryUrl) {
    console.warn(
      `[flmux] CLI entry '${extension.cliEntryRelativePath}' for '${extension.id}' could not be resolved from ${extension.origin} origin at ${extension.originPath}`
    );
    return null;
  }
  const cached = rawCliCommandCache.get(entryUrl);
  if (cached !== undefined) return cached;
  let result: FlmuxExtensionCommand | null;
  try {
    const module = (await import(entryUrl)) as CliModule;
    const def = module.default;
    if (isFlmuxExtensionCommand(def)) {
      result = def;
    } else {
      console.warn(
        `[flmux] CLI extension '${extension.id}' must default-export defineExtensionCommand({...}) from @flmux/extension-api/cli`
      );
      result = null;
    }
  } catch (error) {
    console.warn(`[flmux] failed to load CLI entry for extension '${extension.id}':`, error);
    result = null;
  }
  rawCliCommandCache.set(entryUrl, result);
  return result;
}

// Lazy: a dataDir/loadConfig-only command must not throw "Provide --origin" before any shell use.
function lazyShellClient(flags: FlmuxCliFlags): ShellClient {
  let real: Promise<ShellClient> | null = null;
  const get = () => (real ??= createFlmuxClient(flags));
  return {
    get: async (path) => (await get()).get(path),
    list: async (path) => (await get()).list(path),
    set: async (path, value) => (await get()).set(path, value),
    call: async (path, args) => (await get()).call(path, args)
  };
}

function isFlmuxExtensionCommand(value: unknown): value is FlmuxExtensionCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[FLMUX_EXTENSION_COMMAND] === true &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

function wrapAsCommandDef(
  def: FlmuxExtensionCommand,
  extensionId: string,
  options: LoadCliCommandDefOptions,
  seen: WeakSet<FlmuxExtensionCommand> = new WeakSet()
): CommandDef {
  if (seen.has(def)) {
    throw new Error(`[flmux] extension '${extensionId}' subCommand graph contains a cycle`);
  }
  seen.add(def);
  const subCommands = def.subCommands
    ? Object.fromEntries(
        Object.entries(def.subCommands).map(([name, sub]) => {
          if (!isFlmuxExtensionCommand(sub)) {
            throw new Error(
              `[flmux] extension '${extensionId}' subCommand '${name}' is not a defineExtensionCommand result`
            );
          }
          return [name, wrapAsCommandDef(sub, extensionId, options, seen)];
        })
      )
    : undefined;
  return {
    meta: def.meta,
    args: def.args,
    subCommands,
    async run(input) {
      const dataDir = options.resolveExtensionDataDir(extensionId);
      if (!dataDir) {
        throw new Error(`[flmux] extension '${extensionId}' is not registered — refusing to run CLI`);
      }
      // Dispose after run: a watch-backed store would otherwise keep the
      // event loop alive and hang the (short-lived) CLI process.
      const configDisposers: Array<() => void> = [];
      const ctx: FlmuxExtensionCliContext = {
        dataDir,
        shell: lazyShellClient(toFlmuxCliFlags(input.args as { origin?: string; client?: string; token?: string })),
        signal: new AbortController().signal,
        loadConfig: createExtensionConfigLoader({
          extId: extensionId,
          dataDir,
          registerDispose: (fn) => configDisposers.push(fn)
        })
      };
      try {
        const result = await def.run(input.args, ctx, input.rawArgs);
        // Subprocess-only: render the return to stdout. In-process callers
        // (invokeInProcessExtensionCli) never reach here — they get the raw return.
        if (def.format) await writeFormattedLines(def.format(result, input.args));
      } finally {
        for (const dispose of configDisposers) {
          try {
            dispose();
          } catch {
            /* best-effort */
          }
        }
      }
    }
  } as CommandDef;
}

async function writeFormattedLines(out: string | Iterable<string> | AsyncIterable<string>): Promise<void> {
  for await (const line of typeof out === "string" ? [out] : out) {
    // Honor backpressure — huge streamed output must not buffer unbounded.
    if (!process.stdout.write(line.endsWith("\n") ? line : `${line}\n`)) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  }
}

export async function discoverLocalCliCommands(extensionsRootDir: string): Promise<DiscoveredLocalCliCommand[]> {
  const extensions = await discoverConfiguredLocalExtensions(extensionsRootDir);
  const commands: DiscoveredLocalCliCommand[] = [];
  const seen = new Set<string>();

  for (const extension of extensions) {
    if (!extension.cliEntryRelativePath) {
      continue;
    }

    const manifestCommands = extension.runtimeManifest.commands ?? [];
    // Under the CommandDef contract the CLI entry resolves to a single
    // subcommand; binding multiple manifest ids to one entry would register
    // the same CommandDef under each id and execute identical behavior
    // regardless of which id the user typed. Warn instead of silently
    // doubling up.
    if (manifestCommands.length > 1) {
      console.warn(
        `[flmux] extension '${extension.id}' declares ${manifestCommands.length} commands sharing one CLI entry; only the first ('${manifestCommands[0]?.id}') will be registered`
      );
    }

    for (const command of manifestCommands.slice(0, 1)) {
      if (seen.has(command.id)) {
        console.warn(`[flmux] duplicate local extension command ignored: ${command.id}`);
        continue;
      }

      seen.add(command.id);
      commands.push({
        commandId: command.id,
        description: command.description,
        extensionId: extension.id,
        extension,
        cliEntryRelativePath: extension.cliEntryRelativePath
      });
    }
  }

  return commands.sort((left, right) => left.commandId.localeCompare(right.commandId));
}

export function defaultExtensionsRootDir() {
  // Compiled binary: import.meta.url is a $bunfs virtual path → derive from the
  // exe instead (same drift the rootDir bug had). Dev: repo `extensions/`.
  const { isDeployLayout, baseDir } = resolveInstallLayout();
  const fallback = isDeployLayout ? resolve(baseDir, "extensions") : resolve(baseDir, "../../../extensions");
  return resolveConfiguredLocalExtensionsRootDir(fallback);
}

// In-process invocation of one extension's `inProcess` CLI command by another.
// Deps are injected (not read from main.ts module scope) so it's unit-testable
// without booting main.

// Stricter than pane-kind serving: a pane-less ext has no role signal → deny.
export function isInProcessCliEntitled(paneKinds: string[], isPaneKindAllowed: (kind: string) => boolean): boolean {
  if (paneKinds.length === 0) return false;
  return paneKinds.some(isPaneKindAllowed);
}

export interface InProcessCliHost {
  canInvoke(callerUserId: string, extId: string): boolean;
  findExtension(extId: string): DiscoveredLocalExtension | null;
  resolveDataDir(extId: string): string | null;
  createShell(callerSessionId: string): ShellClient | null;
  createConfigLoader(
    extId: string,
    dataDir: string,
    registerDispose: (fn: () => void) => void
  ): FlmuxExtensionCliContext["loadConfig"];
}

export interface InProcessCliInvocation {
  callerSessionId: string;
  callerUserId: string;
  extId: string;
  /** Shell-style args: subcommand path tokens first, then flags/positionals. */
  argv: string[];
  signal?: AbortSignal;
}

export async function invokeInProcessExtensionCli(
  host: InProcessCliHost,
  { callerSessionId, callerUserId, extId, argv, signal }: InProcessCliInvocation
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!host.canInvoke(callerUserId, extId)) {
    throw new Error(`forbidden: user is not entitled to invoke '${extId}'`);
  }
  const extension = host.findExtension(extId);
  if (!extension) throw new Error(`unknown extension '${extId}'`);
  const root = await loadRawCliCommand(extension);
  if (!root) throw new Error(`extension '${extId}' has no loadable CLI`);
  // Consume leading subcommand tokens (path before flags — standard CLI shape);
  // the remaining argv is parsed by citty's parseArgs below for subprocess parity.
  let cmd: FlmuxExtensionCommand = root;
  let i = 0;
  while (i < argv.length && cmd.subCommands && Object.hasOwn(cmd.subCommands, argv[i]!)) {
    cmd = cmd.subCommands[argv[i]!]!;
    i++;
  }
  const rest = argv.slice(i);
  // loadRawCliCommand validates only the root; match wrapAsCommandDef so a
  // malformed nested leaf fails cleanly, not as a TypeError on run.
  if (!isFlmuxExtensionCommand(cmd)) {
    throw new Error(`command '${[extId, ...argv].join(" ")}' is not a valid extension command`);
  }
  if (!cmd.inProcess) {
    throw new Error(`command '${[extId, ...argv].join(" ")}' is not in-process callable (set inProcess:true)`);
  }
  // Subcommand tokens must come first (the locked argv shape) — any leftover
  // token at a subCommands-bearing node means the path didn't resolve to a
  // leaf. Reject loudly; a flags-before-subcommand argv must not silently run
  // the group (mri eats unknown-flag values, so parsed._ can't detect this).
  if (cmd.subCommands && Object.keys(cmd.subCommands).length > 0 && rest.length > 0) {
    throw new Error(`unknown command '${[extId, ...argv].join(" ")}'`);
  }
  // Parse before shell/ctx so invalid argv surfaces as a parse error, never
  // masked by a reconnect race.
  const parsedArgs = parseArgs(rest, cmd.args ?? {});
  const dataDir = host.resolveDataDir(extId);
  if (!dataDir) throw new Error(`extension '${extId}' is not registered`);
  const shell = host.createShell(callerSessionId);
  if (!shell) throw new Error("session shell unavailable (reconnect in progress)");
  const configDisposers: Array<() => void> = [];
  const ctx: FlmuxExtensionCliContext = {
    dataDir,
    shell,
    sessionId: callerSessionId,
    signal: signal ?? new AbortController().signal,
    loadConfig: host.createConfigLoader(extId, dataDir, (fn) => configDisposers.push(fn))
  };
  try {
    return await cmd.run(parsedArgs as never, ctx, rest);
  } finally {
    for (const dispose of configDisposers) {
      try {
        dispose();
      } catch {
        /* best-effort */
      }
    }
  }
}
