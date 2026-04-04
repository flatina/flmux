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
        const { client, paneId, detectNewPanes } = await resolvePaneClient(args);
        await clickBrowserPane(client, paneId, args.target);
        const newPanes = await detectNewPanes();
        if (args.json) {
          printJson({ ok: true, paneId, ...(newPanes.length > 0 ? { newPanes } : {}) });
          return;
        }
        await reportNewPanes(() => Promise.resolve(newPanes));
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
        const { client, paneId, detectNewPanes } = await resolvePaneClient(args);
        const value = await evalBrowserPane(client, paneId, args.script);
        const newPanes = await detectNewPanes();
        const result = { ok: true, paneId, value, ...(newPanes.length > 0 ? { newPanes } : {}) };
        if (printMaybeJson(args.json, result)) return;
        if (typeof value === "string") {
          console.log(value);
        } else {
          console.log(JSON.stringify(value, null, 2));
        }
        await reportNewPanes(() => Promise.resolve(newPanes));
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
    paneId: Awaited<ReturnType<typeof resolveBrowserPaneId>>,
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
      const { client, paneId, detectNewPanes } = await resolvePaneClient(args);
      const url = await runAction(client, paneId, normalizeWaitUntil(args.waitUntil), parseIdleMs(args.idleMs));
      const newPanes = await detectNewPanes();
      const result = { ok: true, paneId, url, ...(newPanes.length > 0 ? { newPanes } : {}) };
      if (printMaybeJson(args.json, result)) return;
      console.log(url);
      await reportNewPanes(() => Promise.resolve(newPanes));
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
      const { client, paneId, detectNewPanes } = await resolvePaneClient(args);

      if (spec.box) {
        const box = await getBrowserPaneBox(client, paneId, args.target ?? "");
        const newPanes = await detectNewPanes();
        const result = { ok: true, paneId, box, ...(newPanes.length > 0 ? { newPanes } : {}) };
        if (printMaybeJson(args.json, result)) return;
        console.log(JSON.stringify(box, null, 2));
        await reportNewPanes(() => Promise.resolve(newPanes));
        return;
      }

      const value = await getBrowserPaneValue(client, paneId, spec.field, args.target, args.name);
      const newPanes = await detectNewPanes();
      const result = { ok: true, paneId, field: spec.field, value, ...(newPanes.length > 0 ? { newPanes } : {}) };
      if (printMaybeJson(args.json, result)) return;
      console.log(value);
      await reportNewPanes(() => Promise.resolve(newPanes));
    }
  });
}

type NewPaneInfo = { paneId: string; url: string | null; openerPaneId: string | null };

async function resolvePaneClient(args: CommonArgs): Promise<{
  client: Awaited<ReturnType<typeof getClient>>;
  paneId: Awaited<ReturnType<typeof resolveBrowserPaneId>>;
  detectNewPanes: () => Promise<NewPaneInfo[]>;
}> {
  const client = await getClient(args.session);
  const paneId = await resolveBrowserPaneId(client, args.pane);
  const beforePaneIds = new Set(await getBrowserPaneIds(client));
  const detectNewPanes = async (): Promise<NewPaneInfo[]> => {
    const deadline = Date.now() + 1500;
    let newPanes: NewPaneInfo[] = [];
    while (Date.now() < deadline) {
      const summary = await client.call("app.summary", undefined);
      newPanes = summary.panes
        .filter((p) => p.kind === "browser" && !beforePaneIds.has(p.paneId))
        .map((p) => ({ paneId: p.paneId, url: (p as { url?: string }).url ?? null, openerPaneId: (p as { openerPaneId?: string }).openerPaneId ?? null }));
      if (newPanes.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return newPanes;
  };
  return { client, paneId, detectNewPanes };
}

async function getBrowserPaneIds(client: Awaited<ReturnType<typeof getClient>>): Promise<string[]> {
  const summary = await client.call("app.summary", undefined);
  return summary.panes.filter((p) => p.kind === "browser").map((p) => p.paneId);
}

async function reportNewPanes(detectNewPanes: () => Promise<NewPaneInfo[]>, json?: boolean): Promise<void> {
  const newPanes = await detectNewPanes();
  if (newPanes.length === 0) return;
  if (json) return; // newPanes already included in JSON result by caller
  for (const pane of newPanes) {
    const opener = pane.openerPaneId ? ` (from ${pane.openerPaneId})` : "";
    console.error(`[new-tab] ${pane.paneId} ${pane.url ?? "about:blank"}${opener}`);
  }
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
