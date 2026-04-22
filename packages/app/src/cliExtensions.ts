import { fileURLToPath } from "node:url";
import type { FlmuxExtensionCliContext, FlmuxExtensionCliRunner, ShellClient } from "@flmux/extension-api";
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

interface FlmuxCliExtensionDispatchOptions {
  commandId: string;
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  extensionsRootDir?: string;
  getClient(clientId?: string): Promise<ShellClient>;
  print(value: unknown): void;
  printError(message: string): void;
}

type CliModule = {
  run?: FlmuxExtensionCliRunner;
  default?: FlmuxExtensionCliRunner;
};

export async function dispatchLocalCliExtensionCommand(options: FlmuxCliExtensionDispatchOptions): Promise<boolean> {
  const command = await resolveLocalCliCommand(
    options.extensionsRootDir ?? defaultExtensionsRootDir(),
    options.commandId
  );
  if (!command) {
    return false;
  }

  // `resolveEntryImportUrl` abstracts origin: source → file:// URL; archive →
  // data:text/javascript;base64,<bundled-bytes>. Data URL import works because
  // cli entries have zero runtime externals by contract (internal design).
  const entryUrl = await command.extension.resolveEntryImportUrl(command.cliEntryRelativePath);
  if (!entryUrl) {
    throw new Error(
      `CLI entry '${command.cliEntryRelativePath}' for '${command.extensionId}' could not be resolved from ${command.extension.origin} origin at ${command.extension.originPath}`
    );
  }

  const module = (await import(/* @vite-ignore */ entryUrl)) as CliModule;
  const runner = module.run ?? module.default;
  if (typeof runner !== "function") {
    throw new Error(`CLI extension '${command.extensionId}' must export named 'run(ctx)' or a default function`);
  }

  const context: FlmuxExtensionCliContext = {
    commandId: options.commandId,
    argv: options.argv,
    env: options.env,
    cwd: options.cwd,
    getClient: options.getClient,
    print: options.print,
    printError: options.printError
  };

  await runner(context);
  return true;
}

export async function discoverLocalCliCommands(extensionsRootDir: string): Promise<DiscoveredLocalCliCommand[]> {
  const extensions = await discoverConfiguredLocalExtensions(extensionsRootDir);
  const commands: DiscoveredLocalCliCommand[] = [];
  const seen = new Set<string>();

  for (const extension of extensions) {
    if (!extension.cliEntryRelativePath) {
      continue;
    }

    for (const command of extension.runtimeManifest.commands ?? []) {
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

async function resolveLocalCliCommand(extensionsRootDir: string, commandId: string) {
  const commands = await discoverLocalCliCommands(extensionsRootDir);
  return commands.find((command) => command.commandId === commandId) ?? null;
}

export function defaultExtensionsRootDir() {
  return resolveConfiguredLocalExtensionsRootDir(fileURLToPath(new URL("../../../extensions/", import.meta.url)));
}
