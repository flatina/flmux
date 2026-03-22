#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { discoverExtensions } from "../main/extension-discovery";
import { getClient, output } from "./commands/_utils";

function buildExtensionSubCommands(): Record<string, () => Promise<ReturnType<typeof defineCommand>>> {
  const commands: Record<string, () => Promise<ReturnType<typeof defineCommand>>> = {};

  let extensions: ReturnType<typeof discoverExtensions>;
  try {
    extensions = discoverExtensions(process.env.FLMUX_ROOT ?? process.cwd());
  } catch {
    return commands;
  }

  for (const ext of extensions) {
    const cliEntry = ext.manifest.cliEntry;
    if (!cliEntry?.startsWith("./") || cliEntry.includes("..")) continue;

    const contribs = ext.manifest.contributions?.commands;
    if (!contribs?.length) continue;

    const cliPath = `${ext.path}/${cliEntry.slice(2)}`;

    for (const contrib of contribs) {
      const cmdId = contrib.id;
      commands[cmdId] = async () => {
        const mod = await import(cliPath);
        const def = mod.command ?? mod.default;
        if (!def) throw new Error(`Extension ${ext.manifest.id} CLI entry has no command export`);

        return defineCommand({
          meta: def.meta ?? { name: cmdId, description: contrib.description },
          args: def.args ?? {},
          run: (ctx) =>
            def.run({
              args: ctx.args,
              getClient: (sessionId?: string) => getClient(sessionId),
              output
            })
        });
      };
    }
  }

  return commands;
}

const main = defineCommand({
  meta: {
    name: "flmux",
    description: "flmux workspace CLI"
  },
  subCommands: {
    session: () => import("./commands/session").then((m) => m.default),
    summary: () => import("./commands/summary").then((m) => m.default),
    split: () => import("./commands/split").then((m) => m.default),
    tab: () => import("./commands/tab").then((m) => m.default),
    edit: () => import("./commands/edit").then((m) => m.default),
    explorer: () => import("./commands/explorer").then((m) => m.default),
    quit: () => import("./commands/quit").then((m) => m.default),
    ptyd: () => import("./commands/ptyd").then((m) => m.default),
    browser: () => import("./commands/browser").then((m) => m.default),
    ext: () => import("./commands/ext").then((m) => m.default),
    ...buildExtensionSubCommands()
  }
});

export function runCli(): Promise<void> {
  return runMain(main);
}
