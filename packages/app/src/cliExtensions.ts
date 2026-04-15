import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { FlmuxExtensionCliContext, FlmuxExtensionCliRunner, ShellClient } from "@flmux/extension-api";
import { discoverLocalExtensions } from "./main/localExtensions";

export interface DiscoveredLocalCliCommand {
  commandId: string;
  description?: string;
  extensionId: string;
  cliEntryPath: string;
}

export interface FlmuxCliExtensionDispatchOptions {
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

export async function dispatchLocalCliExtensionCommand(
  options: FlmuxCliExtensionDispatchOptions
): Promise<boolean> {
  const command = await resolveLocalCliCommand(options.extensionsRootDir ?? defaultExtensionsRootDir(), options.commandId);
  if (!command) {
    return false;
  }

  const module = await importCliModule(command.cliEntryPath);
  const runner = module.run ?? module.default;
  if (typeof runner !== "function") {
    throw new Error(
      `CLI extension '${command.extensionId}' must export named 'run(ctx)' or a default function`
    );
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
  const extensions = await discoverLocalExtensions(extensionsRootDir);
  const commands: DiscoveredLocalCliCommand[] = [];
  const seen = new Set<string>();

  for (const extension of extensions) {
    if (!extension.cliEntryPath) {
      continue;
    }

    for (const command of extension.manifest.commands ?? []) {
      if (seen.has(command.id)) {
        console.warn(`[flmux] duplicate local extension command ignored: ${command.id}`);
        continue;
      }

      seen.add(command.id);
      commands.push({
        commandId: command.id,
        description: command.description,
        extensionId: extension.id,
        cliEntryPath: extension.cliEntryPath
      });
    }
  }

  return commands.sort((left, right) => left.commandId.localeCompare(right.commandId));
}

export async function resolveLocalCliCommand(extensionsRootDir: string, commandId: string) {
  const commands = await discoverLocalCliCommands(extensionsRootDir);
  return commands.find((command) => command.commandId === commandId) ?? null;
}

export function defaultExtensionsRootDir() {
  const override = process.env.FLMUX_EXTENSIONS_ROOT;
  if (override?.trim()) {
    return override;
  }

  return fileURLToPath(new URL("../../../extensions/", import.meta.url));
}

export async function importCliModule(cliEntryPath: string): Promise<CliModule> {
  return await import(pathToFileURL(cliEntryPath).href) as CliModule;
}
