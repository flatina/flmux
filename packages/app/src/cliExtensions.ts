import { resolve } from "node:path";
import type { CommandDef } from "citty";
import { resolveInstallLayout } from "./main/flmuxPaths";
import {
  FLMUX_EXTENSION_COMMAND,
  type FlmuxExtensionCliContext,
  type FlmuxExtensionCommand
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
  const entryUrl = await command.extension.resolveEntryImportUrl(command.cliEntryRelativePath);
  if (!entryUrl) {
    console.warn(
      `[flmux] CLI entry '${command.cliEntryRelativePath}' for '${command.extensionId}' could not be resolved from ${command.extension.origin} origin at ${command.extension.originPath}`
    );
    return null;
  }

  try {
    const module = (await import(entryUrl)) as CliModule;
    const def = module.default;
    if (!isFlmuxExtensionCommand(def)) {
      console.warn(
        `[flmux] CLI extension '${command.extensionId}' must default-export defineExtensionCommand({...}) from @flmux/extension-api/cli`
      );
      return null;
    }
    return wrapAsCommandDef(def, command.extensionId, options);
  } catch (error) {
    console.warn(`[flmux] failed to load CLI entry for extension '${command.extensionId}':`, error);
    return null;
  }
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
      const ctx: FlmuxExtensionCliContext = { dataDir };
      await def.run(input.args, ctx, input.rawArgs);
    }
  } as CommandDef;
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
