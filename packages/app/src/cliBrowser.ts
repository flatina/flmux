import { writeFileSync } from "node:fs";
import { defineCommand, type CommandDef } from "citty";
import { commonArgs, printJson, resolveClientId, resolveOrigin, toFlmuxCliFlags } from "@flmux/extension-api/cli";
import type { FlmuxCliFlags } from "@flmux/extension-api/cli";

interface PathListResult {
  ok: boolean;
  found?: boolean;
  entries?: Array<{ name: string; path: string; kind: string }>;
  code?: string;
  error?: string;
}

interface PathGetResult {
  ok: boolean;
  found?: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

interface PathCallResult {
  ok: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

async function apiPost<T>(origin: string, pathname: string, body: unknown, flags: FlmuxCliFlags): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...buildAuthHeaders(flags) },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `POST ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return payload as T;
}

function buildAuthHeaders(flags: FlmuxCliFlags): Record<string, string> {
  const token = flags.token ?? process.env.FLMUX_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Throws when the underlying path operation failed — surfaces ModelPathError codes verbatim. */
function unwrap<T extends { ok: boolean; code?: string; error?: string }>(label: string, result: T): T {
  if (!result.ok) {
    const code = result.code ? ` [${result.code}]` : "";
    throw new Error(`${label}: ${result.error ?? "unknown error"}${code}`);
  }
  return result;
}

/** Resolve --pane explicitly, otherwise pick first browser pane via slot-free
 * status paths. HTTP CLI has no caller slot, so `/panes` (implicit-current)
 * returns INVALID_VALUE; walk `/status/workspaces` → first workspace's panes. */
async function resolvePaneId(origin: string, clientId: string, flags: FlmuxCliFlags, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const wsList = unwrap(
    "resolve --pane (workspaces list)",
    (await apiPost<{ result: PathListResult }>(
      origin,
      "/api/model/path/list",
      { authorityClientId: clientId, path: "/status/workspaces" },
      flags
    )).result
  );
  for (const wsEntry of wsList.entries ?? []) {
    const paneList = unwrap(
      "resolve --pane (workspace panes list)",
      (await apiPost<{ result: PathListResult }>(
        origin,
        "/api/model/path/list",
        { authorityClientId: clientId, path: `${wsEntry.path}/panes` },
        flags
      )).result
    );
    for (const paneEntry of paneList.entries ?? []) {
      // status pane path is `.../panes/{id}` — last segment is paneId.
      const paneId = paneEntry.path.split("/").pop() ?? "";
      if (!paneId) continue;
      const kindResult = unwrap(
        "resolve --pane (pane kind)",
        (await apiPost<{ result: PathGetResult }>(
          origin,
          "/api/model/path/get",
          { authorityClientId: clientId, path: `/panes/${paneId}/kind` },
          flags
        )).result
      );
      if (kindResult.value === "browser") return paneId;
    }
  }
  throw new Error("no browser pane found across workspaces; pass --pane <id>");
}

async function callBrowser(
  flags: FlmuxCliFlags,
  paneFlag: string | undefined,
  op: string,
  args: Record<string, unknown>
): Promise<PathCallResult> {
  const origin = resolveOrigin(flags);
  const clientId = await resolveClientId(origin, flags);
  const paneId = await resolvePaneId(origin, clientId, flags, paneFlag);
  const wrapped = await apiPost<{ result: PathCallResult }>(
    origin,
    "/api/model/path/call",
    { authorityClientId: clientId, path: `/panes/${paneId}/browser/${op}`, args },
    flags
  );
  return unwrap(`browser ${op}`, wrapped.result);
}

const paneArg = { type: "string" as const, description: "Pane id (defaults to first browser pane)" };

const openCmd = defineCommand({
  meta: { name: "open", description: "Open or navigate browser pane to URL" },
  args: {
    ...commonArgs,
    url: { type: "positional" as const, description: "URL", required: true },
    pane: paneArg
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    if (args.pane) {
      // Navigate existing pane via path.set on /panes/{id}/browser/url
      const result = await apiPost(origin, "/api/model/path/set", {
        authorityClientId: clientId,
        path: `/panes/${args.pane}/browser/url`,
        value: args.url
      }, flags);
      printJson(result);
      return;
    }
    // No --pane: create a new browser pane via /panes/new path.call
    const result = await apiPost(origin, "/api/model/path/call", {
      authorityClientId: clientId,
      path: "/panes/new",
      args: { kind: "browser", url: args.url }
    }, flags);
    printJson(result);
  }
});

const navigateCmd = defineCommand({
  meta: { name: "navigate", description: "Navigate pane to URL (persisted via state path)" },
  args: {
    ...commonArgs,
    url: { type: "positional" as const, description: "URL", required: true },
    pane: paneArg
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    const paneId = await resolvePaneId(origin, clientId, flags, args.pane);
    printJson(await apiPost(origin, "/api/model/path/set", {
      authorityClientId: clientId,
      path: `/panes/${paneId}/browser/url`,
      value: args.url
    }, flags));
  }
});

const backCmd = defineCommand({
  meta: { name: "back", description: "Browser history goBack" },
  args: { ...commonArgs, pane: paneArg },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "goBack", {}));
  }
});

const reloadCmd = defineCommand({
  meta: { name: "reload", description: "Reload pane" },
  args: { ...commonArgs, pane: paneArg },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "reload", {}));
  }
});

const evalCmd = defineCommand({
  meta: { name: "eval", description: "Evaluate JS expression in pane" },
  args: {
    ...commonArgs,
    script: { type: "positional" as const, description: "JS expression", required: true },
    pane: paneArg
  },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "evaluate", { script: args.script }));
  }
});

const clickCmd = defineCommand({
  meta: { name: "click", description: "Click at viewport coordinates" },
  args: {
    ...commonArgs,
    x: { type: "positional" as const, description: "X (CSS px)", required: true },
    y: { type: "positional" as const, description: "Y (CSS px)", required: true },
    pane: paneArg,
    button: { type: "string" as const, description: "left|middle|right (default: left)" },
    clicks: { type: "string" as const, description: "Click count (default: 1)" },
    modifiers: { type: "string" as const, description: "Comma-separated: alt,ctrl,meta,shift" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = {
      x: Number(args.x),
      y: Number(args.y)
    };
    if (args.button) callArgs.button = args.button;
    if (args.clicks) callArgs.clickCount = Number(args.clicks);
    if (args.modifiers) callArgs.modifiers = String(args.modifiers).split(",").map((s) => s.trim()).filter(Boolean);
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "click", callArgs));
  }
});

const typeCmd = defineCommand({
  meta: { name: "type", description: "Type text (native input dispatch)" },
  args: {
    ...commonArgs,
    text: { type: "positional" as const, description: "Text to type", required: true },
    pane: paneArg
  },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "type", { text: args.text }));
  }
});

const pressCmd = defineCommand({
  meta: { name: "press", description: "Press a key (e.g. Enter, Tab, ArrowUp)" },
  args: {
    ...commonArgs,
    key: { type: "positional" as const, description: "Key name", required: true },
    pane: paneArg,
    modifiers: { type: "string" as const, description: "Comma-separated: alt,ctrl,meta,shift" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = { key: args.key };
    if (args.modifiers) callArgs.modifiers = String(args.modifiers).split(",").map((s) => s.trim()).filter(Boolean);
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "press", callArgs));
  }
});

const scrollCmd = defineCommand({
  meta: { name: "scroll", description: "Dispatch wheel scroll event" },
  args: {
    ...commonArgs,
    dx: { type: "positional" as const, description: "Delta X (px)", required: true },
    dy: { type: "positional" as const, description: "Delta Y (px)", required: true },
    pane: paneArg,
    x: { type: "string" as const, description: "Anchor X" },
    y: { type: "string" as const, description: "Anchor Y" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = {
      dx: Number(args.dx),
      dy: Number(args.dy)
    };
    if (args.x) callArgs.x = Number(args.x);
    if (args.y) callArgs.y = Number(args.y);
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "scroll", callArgs));
  }
});

const screenshotCmd = defineCommand({
  meta: { name: "screenshot", description: "Capture pane screenshot" },
  args: {
    ...commonArgs,
    pane: paneArg,
    format: { type: "string" as const, description: "png|jpeg (default: png)" },
    quality: { type: "string" as const, description: "JPEG quality 0-100" },
    out: { type: "string" as const, description: "Write bytes to file (omit to print base64 envelope)" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = {};
    if (args.format) callArgs.format = args.format;
    if (args.quality) callArgs.quality = Number(args.quality);
    const callResult = await callBrowser(toFlmuxCliFlags(args), args.pane, "screenshot", callArgs);
    const envelope = callResult.value as {
      ok: boolean;
      data?: string;
      mime?: string;
      format?: string;
      code?: string;
      message?: string;
    };
    if (envelope.ok && typeof envelope.data === "string" && args.out) {
      const bytes = base64ToBytes(envelope.data);
      writeFileSync(args.out, bytes);
      printJson({ ok: true, written: args.out, bytes: bytes.byteLength, mime: envelope.mime, format: envelope.format });
      return;
    }
    printJson(envelope);
  }
});

const capabilitiesCmd = defineCommand({
  meta: { name: "capabilities", description: "Per-surface automation capabilities" },
  args: { ...commonArgs, pane: paneArg },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "capabilities", {}));
  }
});

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const browserCmd: CommandDef = defineCommand({
  meta: { name: "browser", description: "Browser pane automation (open, navigate, click, eval, screenshot, ...)" },
  subCommands: {
    open: openCmd as CommandDef,
    navigate: navigateCmd as CommandDef,
    back: backCmd as CommandDef,
    reload: reloadCmd as CommandDef,
    eval: evalCmd as CommandDef,
    click: clickCmd as CommandDef,
    type: typeCmd as CommandDef,
    press: pressCmd as CommandDef,
    scroll: scrollCmd as CommandDef,
    screenshot: screenshotCmd as CommandDef,
    capabilities: capabilitiesCmd as CommandDef
  }
}) as CommandDef;
