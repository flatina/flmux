#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import {
  backBrowserPane,
  type BrowserWaitCommand,
  clickBrowserPane,
  evalBrowserPane,
  fillBrowserPane,
  forwardBrowserPane,
  getBrowserPaneBox,
  getBrowserPaneValue,
  navigateBrowserPane,
  pressBrowserPane,
  reloadBrowserPane,
  snapshotBrowserPane,
  waitForBrowserPane
} from "./automation";
import { getClient, printJson, resolveBrowserPaneId, sessionArg } from "./support";

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

type GetterSpec = {
  field: "url" | "title" | "text" | "html" | "value" | "attr";
  name: string;
  description: string;
  target?: boolean;
  attrName?: boolean;
  box?: boolean;
};

const getterSpecs: GetterSpec[] = [
  { name: "url", field: "url", description: "Get the current URL" },
  { name: "title", field: "title", description: "Get the current page title" },
  { name: "text", field: "text", description: "Get text content from a ref or selector", target: true },
  { name: "html", field: "html", description: "Get innerHTML from a ref or selector", target: true },
  { name: "value", field: "value", description: "Get input value from a ref or selector", target: true },
  { name: "attr", field: "attr", description: "Get an attribute from a ref or selector", target: true, attrName: true },
  { name: "box", field: "text", description: "Get bounding box from a ref or selector", target: true, box: true }
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
        const { client, paneId } = await resolvePaneClient(args);
        const snapshot = await snapshotBrowserPane(client, paneId, !!args.compact);
        const result = { ok: true, paneId, snapshot };
        if (printMaybeJson(args.json, result)) return;
        console.log(snapshot);
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
        const { client, paneId } = await resolvePaneClient(args);
        const url = await navigateBrowserPane(client, paneId, args.url, normalizeWaitUntil(args.waitUntil), parseIdleMs(args.idleMs));
        const result = { ok: true, paneId, url };
        if (printMaybeJson(args.json, result)) return;
        console.log(url);
      }
    }),
    back: createHistoryCommand("back", "Navigate back in history", backBrowserPane),
    forward: createHistoryCommand("forward", "Navigate forward in history", forwardBrowserPane),
    reload: createHistoryCommand("reload", "Reload the current page", reloadBrowserPane),
    click: defineCommand({
      meta: { name: "click", description: "Click a ref or selector" },
      args: {
        ...commonArgs,
        target: { type: "positional", required: true, description: "Ref or selector" }
      },
      run: async ({ args }) => {
        const { client, paneId } = await resolvePaneClient(args);
        await clickBrowserPane(client, paneId, args.target);
        if (args.json) {
          printJson({ ok: true, paneId });
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
        const { client, paneId } = await resolvePaneClient(args);
        await fillBrowserPane(client, paneId, args.target, args.text);
        if (args.json) {
          printJson({ ok: true, paneId });
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
        const { client, paneId } = await resolvePaneClient(args);
        await pressBrowserPane(client, paneId, args.key);
        if (args.json) {
          printJson({ ok: true, paneId });
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
        const { client, paneId } = await resolvePaneClient(args);
        await waitForBrowserPane(client, paneId, normalizeWaitParams(args));
        if (args.json) {
          printJson({ ok: true, paneId });
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
        const { client, paneId } = await resolvePaneClient(args);
        const value = await evalBrowserPane(client, paneId, args.script);
        const result = { ok: true, paneId, value };
        if (printMaybeJson(args.json, result)) return;
        if (typeof value === "string") {
          console.log(value);
          return;
        }
        console.log(JSON.stringify(value, null, 2));
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
  runAction: (
    client: Awaited<ReturnType<typeof getClient>>,
    paneId: ReturnType<typeof resolveBrowserPaneId>,
    waitUntil: "none" | "load" | "idle",
    idleMs: number
  ) => Promise<string>
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
      const { client, paneId } = await resolvePaneClient(args);
      const url = await runAction(client, paneId, normalizeWaitUntil(args.waitUntil), parseIdleMs(args.idleMs));
      const result = { ok: true, paneId, url };
      if (printMaybeJson(args.json, result)) return;
      console.log(url);
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
      const { client, paneId } = await resolvePaneClient(args);

      if (spec.box) {
        const box = await getBrowserPaneBox(client, paneId, args.target ?? "");
        const result = { ok: true, paneId, box };
        if (printMaybeJson(args.json, result)) return;
        console.log(JSON.stringify(box, null, 2));
        return;
      }

      const value = await getBrowserPaneValue(client, paneId, spec.field, args.target, args.name);
      const result = { ok: true, paneId, field: spec.field, value };
      if (printMaybeJson(args.json, result)) return;
      console.log(value);
    }
  });
}

async function resolvePaneClient(args: CommonArgs): Promise<{
  client: Awaited<ReturnType<typeof getClient>>;
  paneId: ReturnType<typeof resolveBrowserPaneId>;
}> {
  return {
    client: await getClient(args.session),
    paneId: resolveBrowserPaneId(args.pane)
  };
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

function parseIdleMs(value?: string): number {
  const parsed = value ? Number(value) : 500;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function normalizeWaitParams(args: {
  value?: string;
  ms?: string;
  text?: string;
  url?: string;
  fn?: string;
}): BrowserWaitCommand {
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
    return { kind: "idle", ms: parseIdleMs(args.ms) };
  }
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return { kind: "duration", ms: asNumber };
  }
  return { kind: "target", target: raw };
}
