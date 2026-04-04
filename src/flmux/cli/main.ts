#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { discoverExtensions } from "../config/extension-discovery";
import { getClient, output } from "./commands/_utils";
import type { ExtensionCliCommand } from "../../types/cli";

function defineExtensionCommand(
  def: ExtensionCliCommand,
  fallbackName: string,
  fallbackDescription?: string
): ReturnType<typeof defineCommand> {
  const run = def.run;
  return defineCommand({
    meta: def.meta ?? { name: fallbackName, description: fallbackDescription },
    args: (def.args ?? {}) as any,
    subCommands: def.subCommands
      ? Object.fromEntries(
          Object.entries(def.subCommands).map(([id, subCommand]) => [
            id,
            () => Promise.resolve(defineExtensionCommand(subCommand, id, subCommand.meta?.description))
          ])
        )
      : undefined,
    run: run
      ? (ctx) =>
          run({
            args: ctx.args,
            getClient: async (sessionId?: string) => (await getClient(sessionId as string | undefined)) as any,
            output
          })
      : undefined
  });
}

function buildExtensionSubCommands(): Record<string, () => Promise<ReturnType<typeof defineCommand>>> {
  const subCommands: Record<string, () => Promise<ReturnType<typeof defineCommand>>> = {};

  let extensions: ReturnType<typeof discoverExtensions>;
  try {
    extensions = discoverExtensions();
  } catch {
    return subCommands;
  }

  for (const ext of extensions) {
    const cliEntry = ext.manifest.cliEntry;
    if (!cliEntry?.startsWith("./") || cliEntry.includes("..")) continue;

    const extensionCommands = ext.manifest.commands;
    if (!extensionCommands?.length) continue;

    const cliPath = `${ext.path}/${cliEntry.slice(2)}`;

    for (const command of extensionCommands) {
      const cmdId = command.id;
      subCommands[cmdId] = async () => {
        const mod = await import(cliPath);
        const def = (mod.command ?? mod.default) as ExtensionCliCommand | undefined;
        if (!def) throw new Error(`Extension ${ext.manifest.id} CLI entry has no command export`);
        return defineExtensionCommand(def, cmdId, command.description);
      };
    }
  }

  return subCommands;
}

const main = defineCommand({
  meta: {
    name: "flmux",
    description: "flmux workspace CLI"
  },
  subCommands: {
    session: () => import("./commands/session").then((m) => m.default),
    summary: () => import("./commands/summary").then((m) => m.default),
    open: () => import("./commands/open").then((m) => m.default),
    split: () => import("./commands/split").then((m) => m.default),
    tab: () => import("./commands/tab").then((m) => m.default),
    edit: () => import("./commands/edit").then((m) => m.default),
    explorer: () => import("./commands/explorer").then((m) => m.default),
    props: () => import("./commands/props").then((m) => m.default),
    quit: () => import("./commands/quit").then((m) => m.default),
    ptyd: () => import("./commands/ptyd").then((m) => m.default),
    ext: () => import("./commands/ext").then((m) => m.default),
    ...buildExtensionSubCommands()
  }
});

export function runCli(): Promise<void> {
  return runMain(main);
}
