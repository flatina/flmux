#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { resolveBrowserPaneId, printJson } from "../cli/browser-utils";
import { getClient, sessionArg } from "../cli/commands/_utils";

const FLWEB_RPC_TIMEOUT_MS = 20_000;

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
        }, FLWEB_RPC_TIMEOUT_MS);
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
        }, FLWEB_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.url);
      }
    }),
    back: defineCommand({
      meta: { name: "back", description: "Navigate back in history" },
      args: {
        ...commonArgs,
        waitUntil: {
          type: "string",
          description: "Wait strategy: none, load, idle",
          default: "load"
        },
        idleMs: { type: "string", description: "Idle wait window in milliseconds" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.back", {
          paneId: resolveBrowserPaneId(args.pane),
          waitUntil: args.waitUntil === "none" || args.waitUntil === "idle" ? args.waitUntil : "load",
          idleMs: args.idleMs ? Number(args.idleMs) : undefined
        }, FLWEB_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.url);
      }
    }),
    forward: defineCommand({
      meta: { name: "forward", description: "Navigate forward in history" },
      args: {
        ...commonArgs,
        waitUntil: {
          type: "string",
          description: "Wait strategy: none, load, idle",
          default: "load"
        },
        idleMs: { type: "string", description: "Idle wait window in milliseconds" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.forward", {
          paneId: resolveBrowserPaneId(args.pane),
          waitUntil: args.waitUntil === "none" || args.waitUntil === "idle" ? args.waitUntil : "load",
          idleMs: args.idleMs ? Number(args.idleMs) : undefined
        }, FLWEB_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.url);
      }
    }),
    reload: defineCommand({
      meta: { name: "reload", description: "Reload the current page" },
      args: {
        ...commonArgs,
        waitUntil: {
          type: "string",
          description: "Wait strategy: none, load, idle",
          default: "load"
        },
        idleMs: { type: "string", description: "Idle wait window in milliseconds" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.reload", {
          paneId: resolveBrowserPaneId(args.pane),
          waitUntil: args.waitUntil === "none" || args.waitUntil === "idle" ? args.waitUntil : "load",
          idleMs: args.idleMs ? Number(args.idleMs) : undefined
        }, FLWEB_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.url);
      }
    }),
    click: defineCommand({
      meta: { name: "click", description: "Click a ref or selector" },
      args: {
        ...commonArgs,
        target: { type: "positional", required: true, description: "Ref or selector" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.click",
          {
            paneId: resolveBrowserPaneId(args.pane),
            target: args.target
          },
          FLWEB_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
        }
      }
    }),
    fill: defineCommand({
      meta: { name: "fill", description: "Fill a ref or selector" },
      args: {
        ...commonArgs,
        target: { type: "positional", required: true, description: "Ref or selector" },
        text: { type: "positional", required: true, description: "Text value" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.fill",
          {
            paneId: resolveBrowserPaneId(args.pane),
            target: args.target,
            text: args.text
          },
          FLWEB_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
        }
      }
    }),
    press: defineCommand({
      meta: { name: "press", description: "Press a key against the active element" },
      args: {
        ...commonArgs,
        key: { type: "positional", required: true, description: "Key name" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.press",
          {
            paneId: resolveBrowserPaneId(args.pane),
            key: args.key
          },
          FLWEB_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
        }
      }
    }),
    wait: defineCommand({
      meta: { name: "wait", description: "Wait for time, load, idle, or target presence" },
      args: {
        ...commonArgs,
        value: { type: "positional", required: false, description: "ms, load, idle, or ref/selector" },
        ms: { type: "string", description: "Idle window in ms for wait idle" },
        text: { type: "string", description: "Wait until page text includes this string" },
        url: { type: "string", description: "Wait until the current URL matches this glob pattern" },
        fn: { type: "string", description: "Wait until this JavaScript expression becomes truthy" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const raw = args.value;
        const asNumber = Number(raw);
        const params = args.text
          ? { kind: "text" as const, text: args.text }
          : args.url
            ? { kind: "url" as const, pattern: args.url }
            : args.fn
              ? { kind: "fn" as const, expression: args.fn }
              : raw === "load"
                ? { kind: "load" as const }
                : raw === "idle"
                  ? { kind: "idle" as const, ms: args.ms ? Number(args.ms) : 500 }
                  : Number.isFinite(asNumber) && asNumber >= 0
                    ? { kind: "duration" as const, ms: asNumber }
                    : { kind: "target" as const, target: raw };

        const result = await client.call(
          "browser.wait",
          {
            paneId: resolveBrowserPaneId(args.pane),
            ...params
          },
          FLWEB_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
        }
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
            }, FLWEB_RPC_TIMEOUT_MS);
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
            }, FLWEB_RPC_TIMEOUT_MS);
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        }),
        text: defineCommand({
          meta: { name: "text", description: "Get text content from a ref or selector" },
          args: {
            ...commonArgs,
            target: { type: "positional", required: true, description: "Ref or selector" }
          },
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "text",
              target: args.target
            }, FLWEB_RPC_TIMEOUT_MS);
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        }),
        html: defineCommand({
          meta: { name: "html", description: "Get innerHTML from a ref or selector" },
          args: {
            ...commonArgs,
            target: { type: "positional", required: true, description: "Ref or selector" }
          },
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "html",
              target: args.target
            }, FLWEB_RPC_TIMEOUT_MS);
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        }),
        value: defineCommand({
          meta: { name: "value", description: "Get input value from a ref or selector" },
          args: {
            ...commonArgs,
            target: { type: "positional", required: true, description: "Ref or selector" }
          },
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "value",
              target: args.target
            }, FLWEB_RPC_TIMEOUT_MS);
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        }),
        attr: defineCommand({
          meta: { name: "attr", description: "Get an attribute from a ref or selector" },
          args: {
            ...commonArgs,
            target: { type: "positional", required: true, description: "Ref or selector" },
            name: { type: "positional", required: true, description: "Attribute name" }
          },
          run: async ({ args }) => {
            const client = await getClient(args.session);
            const result = await client.call("browser.get", {
              paneId: resolveBrowserPaneId(args.pane),
              field: "attr",
              target: args.target,
              name: args.name
            }, FLWEB_RPC_TIMEOUT_MS);
            if (args.json) {
              printJson(result);
              return;
            }
            console.log(result.value);
          }
        })
      }
    }),
    eval: defineCommand({
      meta: { name: "eval", description: "Evaluate JavaScript in the page context" },
      args: {
        ...commonArgs,
        script: { type: "positional", required: true, description: "JavaScript expression or return statement" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.eval", {
          paneId: resolveBrowserPaneId(args.pane),
          script: args.script
        }, FLWEB_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        if (typeof result.value === "string") {
          console.log(result.value);
          return;
        }
        console.log(JSON.stringify(result.value, null, 2));
      }
    })
  }
});

export function runFlweb(): Promise<void> {
  return runMain(main);
}
