import { fileURLToPath } from "node:url";
import type { CommandDef } from "citty";
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
  default?: CommandDef;
};

/**
 * Dynamically import an extension's CLI entry and return its default-exported
 * citty `CommandDef`. Returns null if the entry or its export is missing —
 * the caller falls back to the other built-in subcommands in that case.
 *
 * Data-URL imports (archive-backed extensions) work because CLI entries are
 * contract-bound to zero runtime externals.
 */
export async function loadLocalCliCommandDef(
  command: DiscoveredLocalCliCommand
): Promise<CommandDef | null> {
  const entryUrl = await command.extension.resolveEntryImportUrl(command.cliEntryRelativePath);
  if (!entryUrl) {
    console.warn(
      `[flmux] CLI entry '${command.cliEntryRelativePath}' for '${command.extensionId}' could not be resolved from ${command.extension.origin} origin at ${command.extension.originPath}`
    );
    return null;
  }

  try {
    const module = (await import(/* @vite-ignore */ entryUrl)) as CliModule;
    const def = module.default;
    if (!isCommandDefShape(def)) {
      console.warn(
        `[flmux] CLI extension '${command.extensionId}' must default-export a citty CommandDef (missing run/subCommands)`
      );
      return null;
    }
    return def;
  } catch (error) {
    console.warn(`[flmux] failed to load CLI entry for extension '${command.extensionId}':`, error);
    return null;
  }
}

/**
 * Loose shape check for a citty CommandDef — requires either a `run` function
 * or a `subCommands` object. Catches wrong-export shapes at load time rather
 * than letting citty crash mid-dispatch.
 */
function isCommandDefShape(value: unknown): value is CommandDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.run === "function" || (typeof record.subCommands === "object" && record.subCommands !== null);
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
  return resolveConfiguredLocalExtensionsRootDir(fileURLToPath(new URL("../../../extensions/", import.meta.url)));
}
