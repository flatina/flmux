#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import type { AppRpcMethod, AppRpcParams, AppRpcResult } from "../shared/app-rpc";
import { printJson, resolveBrowserPaneId } from "../cli/browser-utils";
import { getClient, sessionArg } from "../cli/commands/_utils";

const FLWEB_RPC_TIMEOUT_MS = 20_000;

const commonArgs = {
  ...sessionArg,
  json: { type: "boolean" as const, description: "Print JSON output" },
  pane: { type: "string" as const, description: "Browser pane ID (falls back to FLMUX_BROWSER)" }
};

type CommonArgs = {
  session?: string;
  json?: boolean;
  pane?: string;
};

type PaneScopedBrowserMethod = {
  [Method in Extract<AppRpcMethod, `browser.${string}`>]: AppRpcParams<Method> extends { paneId: string } ? Method : never;
}[Extract<AppRpcMethod, `browser.${string}`>];

type GetterSpec = {
  field: "url" | "title" | "text" | "html" | "value" | "attr";
  name: string;
  description: string;
  target?: boolean;
  attrName?: boolean;
  printer?: (result: AppRpcResult<"browser.get"> | AppRpcResult<"browser.box">) => void;
  method?: "browser.get" | "browser.box";
};

const getterSpecs: GetterSpec[] = [
  { name: "url", field: "url", description: "Get the current URL" },
  { name: "title", field: "title", description: "Get the current page title" },
  { name: "text", field: "text", description: "Get text content from a ref or selector", target: true },
  { name: "html", field: "html", description: "Get innerHTML from a ref or selector", target: true },
  { name: "value", field: "value", description: "Get input value from a ref or selector", target: true },
  { name: "attr", field: "attr", description: "Get an attribute from a ref or selector", target: true, attrName: true },
  {
    name: "box",
    field: "text",
    description: "Get bounding box from a ref or selector",
    target: true,
    method: "browser.box",
    printer: (result) => console.log(JSON.stringify((result as AppRpcResult<"browser.box">).box, null, 2))
  }
];

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
        const result = await callPaneBrowser(args, "browser.snapshot", {
          compact: !!args.compact
        });
        if (printMaybeJson(args.json, result)) return;
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
        const result = await callPaneBrowser(args, "browser.navigate", {
          url: args.url,
          waitUntil: normalizeWaitUntil(args.waitUntil),
          idleMs: parseIdleMs(args.idleMs)
        });
        if (printMaybeJson(args.json, result)) return;
        console.log(result.url);
      }
    }),
    back: createHistoryCommand("back", "Navigate back in history", "browser.back"),
    forward: createHistoryCommand("forward", "Navigate forward in history", "browser.forward"),
    reload: createHistoryCommand("reload", "Reload the current page", "browser.reload"),
    click: defineCommand({
      meta: { name: "click", description: "Click a ref or selector" },
      args: {
        ...commonArgs,
        target: { type: "positional", required: true, description: "Ref or selector" }
      },
      run: async ({ args }) => {
        const result = await callPaneBrowser(args, "browser.click", {
          target: args.target
        });
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
        const result = await callPaneBrowser(args, "browser.fill", {
          target: args.target,
          text: args.text
        });
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
        const result = await callPaneBrowser(args, "browser.press", {
          key: args.key
        });
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
        const result = await callPaneBrowser(args, "browser.wait", normalizeWaitParams(args));
        if (args.json) {
          printJson(result);
        }
      }
    }),
    get: defineCommand({
      meta: { name: "get", description: "Read a value from the active browser pane" },
      subCommands: Object.fromEntries(getterSpecs.map((spec) => [spec.name, createGetterCommand(spec)]))
    }),
    eval: defineCommand({
      meta: { name: "eval", description: "Evaluate JavaScript in the page context" },
      args: {
        ...commonArgs,
        script: { type: "positional", required: true, description: "JavaScript expression or return statement" }
      },
      run: async ({ args }) => {
        const result = await callPaneBrowser(args, "browser.eval", {
          script: args.script
        });
        if (printMaybeJson(args.json, result)) return;
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

function createHistoryCommand(
  name: string,
  description: string,
  method: Extract<PaneScopedBrowserMethod, "browser.back" | "browser.forward" | "browser.reload">
) {
  return defineCommand({
    meta: { name, description },
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
      const result = await callPaneBrowser(args, method, {
        waitUntil: normalizeWaitUntil(args.waitUntil),
        idleMs: parseIdleMs(args.idleMs)
      });
      if (printMaybeJson(args.json, result)) return;
      console.log(result.url);
    }
  });
}

function createGetterCommand(spec: GetterSpec) {
  return defineCommand({
    meta: { name: spec.name, description: spec.description },
    args: {
      ...commonArgs,
      ...(spec.target ? { target: { type: "positional" as const, required: true, description: "Ref or selector" } } : {}),
      ...(spec.attrName ? { name: { type: "positional" as const, required: true, description: "Attribute name" } } : {})
    },
    run: async ({ args }) => {
      if (spec.method === "browser.box") {
        const result = await callPaneBrowser(args, "browser.box", {
          target: args.target
        });
        if (printMaybeJson(args.json, result)) return;
        spec.printer?.(result);
        return;
      }

      const result = await callPaneBrowser(args, "browser.get", {
        field: spec.field,
        target: spec.target ? args.target : undefined,
        name: spec.attrName ? args.name : undefined
      });
      if (printMaybeJson(args.json, result)) return;
      console.log(result.value);
    }
  });
}

async function callPaneBrowser<Method extends PaneScopedBrowserMethod>(
  args: CommonArgs,
  method: Method,
  params: Omit<AppRpcParams<Method>, "paneId">
): Promise<AppRpcResult<Method>> {
  const client = await getClient(args.session);
  return client.call(
    method,
    {
      paneId: resolveBrowserPaneId(args.pane),
      ...params
    } as AppRpcParams<Method>,
    FLWEB_RPC_TIMEOUT_MS
  );
}

function printMaybeJson(json: boolean | undefined, result: unknown): boolean {
  if (!json) {
    return false;
  }

  printJson(result);
  return true;
}

function normalizeWaitUntil(value?: string): "none" | "load" | "idle" {
  return value === "none" || value === "idle" ? value : "load";
}

function parseIdleMs(value?: string): number | undefined {
  return value ? Number(value) : undefined;
}

function normalizeWaitParams(args: {
  value?: string;
  ms?: string;
  text?: string;
  url?: string;
  fn?: string;
}): Omit<AppRpcParams<"browser.wait">, "paneId"> {
  const raw = args.value;
  const asNumber = Number(raw);

  if (args.text) {
    return { kind: "text", text: args.text };
  }
  if (args.url) {
    return { kind: "url", pattern: args.url };
  }
  if (args.fn) {
    return { kind: "fn", expression: args.fn };
  }
  if (raw === "load") {
    return { kind: "load" };
  }
  if (raw === "idle") {
    return { kind: "idle", ms: args.ms ? Number(args.ms) : 500 };
  }
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return { kind: "duration", ms: asNumber };
  }
  return { kind: "target", target: raw };
}
