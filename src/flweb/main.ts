#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { resolveBrowserPaneId, printJson } from "../cli/browser-utils";
import { getClient, sessionArg } from "../cli/commands/_utils";

const commonArgs = {
  ...sessionArg,
  json: { type: "boolean" as const, description: "Print JSON output" },
  pane: { type: "string" as const, description: "Browser pane ID (falls back to FLMUX_BROWSER)" }
};

const main = defineCommand({
  meta: {
    name: "flweb",
    description: "Hot-path browser automation against a flmux browser pane"
  },
  subCommands: {
    snapshot: defineCommand({
      meta: { name: "snapshot", description: "Capture an interactive snapshot" },
      args: {
        ...commonArgs,
        compact: { type: "boolean", description: "Compact snapshot output" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.snapshot", {
          paneId: resolveBrowserPaneId(args.pane),
          compact: !!args.compact
        });
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.snapshot);
      }
    }),
    navigate: defineCommand({
      meta: { name: "navigate", description: "Navigate the browser pane to a URL" },
      args: {
        ...commonArgs,
        url: { type: "positional", required: true, description: "Target URL" },
        waitUntil: {
          type: "string",
          description: "Wait strategy: none, load, idle",
          default: "load"
        },
        idleMs: { type: "string", description: "Idle wait window in milliseconds" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.navigate", {
          paneId: resolveBrowserPaneId(args.pane),
          url: args.url,
          waitUntil: args.waitUntil === "none" || args.waitUntil === "idle" ? args.waitUntil : "load",
          idleMs: args.idleMs ? Number(args.idleMs) : undefined
        });
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.url);
      }
    }),
    get: defineCommand({
      meta: { name: "get", description: "Read a value from the active browser pane" },
      subCommands: {
        url: defineCommand({
          meta: { name: "url", description: "Get the current URL" },
          args: commonArgs,
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "url"
            });
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        }),
        title: defineCommand({
          meta: { name: "title", description: "Get the current page title" },
          args: commonArgs,
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "title"
            });
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        })
      }
    })
  }
});

export function runFlweb(): Promise<void> {
  return runMain(main);
}
