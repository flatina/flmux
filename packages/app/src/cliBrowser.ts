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
async function resolvePaneId(
  origin: string,
  clientId: string,
  flags: FlmuxCliFlags,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;
  const wsList = unwrap(
    "resolve --pane (workspaces list)",
    (
      await apiPost<{ result: PathListResult }>(
        origin,
        "/api/model/path/list",
        { authorityClientId: clientId, path: "/status/workspaces" },
        flags
      )
    ).result
  );
  for (const wsEntry of wsList.entries ?? []) {
    const paneList = unwrap(
      "resolve --pane (workspace panes list)",
      (
        await apiPost<{ result: PathListResult }>(
          origin,
          "/api/model/path/list",
          { authorityClientId: clientId, path: `${wsEntry.path}/panes` },
          flags
        )
      ).result
    );
    for (const paneEntry of paneList.entries ?? []) {
      // status pane path is `.../panes/{id}` — last segment is paneId.
      const paneId = paneEntry.path.split("/").pop() ?? "";
      if (!paneId) continue;
      const kindResult = unwrap(
        "resolve --pane (pane kind)",
        (
          await apiPost<{ result: PathGetResult }>(
            origin,
            "/api/model/path/get",
            { authorityClientId: clientId, path: `/panes/${paneId}/kind` },
            flags
          )
        ).result
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
      const result = await apiPost(
        origin,
        "/api/model/path/set",
        {
          authorityClientId: clientId,
          path: `/panes/${args.pane}/browser/url`,
          value: args.url
        },
        flags
      );
      printJson(result);
      return;
    }
    // No --pane: create a new browser pane via /panes/new path.call
    const result = await apiPost(
      origin,
      "/api/model/path/call",
      {
        authorityClientId: clientId,
        path: "/panes/new",
        args: { kind: "browser", url: args.url }
      },
      flags
    );
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
    printJson(
      await apiPost(
        origin,
        "/api/model/path/set",
        {
          authorityClientId: clientId,
          path: `/panes/${paneId}/browser/url`,
          value: args.url
        },
        flags
      )
    );
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

function parseModifiers(raw?: unknown): string[] | undefined {
  if (!raw) return undefined;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Agent target string passed through to BrowserAgentSurface — `@e1` ref,
 * CSS selector, `text=`/`label=`/`role=`/`testid=`. Coord `x,y` also valid. */
const targetArg = {
  type: "positional" as const,
  description: "Target (@ref / CSS / text=.. / role=..[name=..])",
  required: true
};
const clickFlags = {
  pane: paneArg,
  button: { type: "string" as const, description: "left|middle|right" },
  clicks: { type: "string" as const, description: "Click count (default 1)" },
  modifiers: { type: "string" as const, description: "Comma-separated: alt,ctrl,meta,shift" }
};

const clickCmd = defineCommand({
  meta: { name: "click", description: "Click an element (target = @ref / CSS / text= / role= / x,y)" },
  args: { ...commonArgs, target: targetArg, ...clickFlags },
  async run({ args }) {
    const callArgs: Record<string, unknown> = { target: args.target };
    if (args.button) callArgs.button = args.button;
    if (args.clicks) callArgs.clickCount = Number(args.clicks);
    const mods = parseModifiers(args.modifiers);
    if (mods) callArgs.modifiers = mods;
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
    if (args.modifiers)
      callArgs.modifiers = String(args.modifiers)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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

// --- Phase 4 agent ops ---

const snapshotCmd = defineCommand({
  meta: { name: "snapshot", description: "Accessibility snapshot with refs (@e1, @e2, ...)" },
  args: { ...commonArgs, pane: paneArg },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "snapshot", {}));
  }
});

const findCmd = defineCommand({
  meta: { name: "find", description: "Find element by role/text/label/testid → ref + rect" },
  args: {
    ...commonArgs,
    by: { type: "positional" as const, description: "role|text|label|testid", required: true },
    value: { type: "positional" as const, description: "Value", required: true },
    pane: paneArg
  },
  async run({ args }) {
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "find", { by: args.by, value: args.value }));
  }
});

function makeTargetCmd(name: string, op: string, desc: string) {
  return defineCommand({
    meta: { name, description: desc },
    args: { ...commonArgs, target: targetArg, pane: paneArg },
    async run({ args }) {
      printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, op, { target: args.target }));
    }
  });
}

const dblclickCmd = makeTargetCmd("dblclick", "dblclick", "Double-click");
const hoverCmd = makeTargetCmd("hover", "hover", "Mouse hover");
const focusCmd = makeTargetCmd("focus", "focus", "Focus element");
const checkCmd = makeTargetCmd("check", "check", "Check checkbox if not already");
const uncheckCmd = makeTargetCmd("uncheck", "uncheck", "Uncheck checkbox if checked");
const scrollToCmd = makeTargetCmd("scroll-to", "scrollTo", "Scroll target into view");

const fillCmd = defineCommand({
  meta: { name: "fill", description: "Clear + type (empty text = clear only)" },
  args: {
    ...commonArgs,
    target: targetArg,
    text: { type: "positional" as const, description: "Text (omit/empty to clear)", required: false },
    pane: paneArg
  },
  async run({ args }) {
    printJson(
      await callBrowser(toFlmuxCliFlags(args), args.pane, "fill", {
        target: args.target,
        text: args.text ?? ""
      })
    );
  }
});

const selectCmd = defineCommand({
  meta: { name: "select", description: "Set <select> value" },
  args: {
    ...commonArgs,
    target: targetArg,
    value: { type: "positional" as const, description: "Option value", required: true },
    pane: paneArg
  },
  async run({ args }) {
    printJson(
      await callBrowser(toFlmuxCliFlags(args), args.pane, "select", {
        target: args.target,
        value: args.value
      })
    );
  }
});

const highlightCmd = defineCommand({
  meta: { name: "highlight", description: "Briefly outline an element" },
  args: {
    ...commonArgs,
    target: targetArg,
    pane: paneArg,
    "duration-ms": { type: "string" as const, description: "Duration (default 1500)" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = { target: args.target };
    if (args["duration-ms"]) callArgs.durationMs = Number(args["duration-ms"]);
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "highlight", callArgs));
  }
});

const waitCmd = defineCommand({
  meta: { name: "wait", description: "Wait for load|idle|<selector>|--text|--url|--fn" },
  args: {
    ...commonArgs,
    variantOrArg: {
      type: "positional" as const,
      description: "load | idle | <selector> | <text-if-flag>",
      required: false
    },
    pane: paneArg,
    text: { type: "string" as const, description: "Wait for body text" },
    url: { type: "string" as const, description: "Wait for URL match (glob)" },
    fn: { type: "string" as const, description: "Wait for JS expression to be truthy" },
    "timeout-ms": { type: "string" as const, description: "Timeout (default 30000)" }
  },
  async run({ args }) {
    const tm = args["timeout-ms"];
    const callArgs: Record<string, unknown> = {};
    if (tm) callArgs.timeoutMs = Number(tm);
    if (args.text) {
      callArgs.variant = "text";
      callArgs.arg = args.text;
    } else if (args.url) {
      callArgs.variant = "url";
      callArgs.arg = args.url;
    } else if (args.fn) {
      callArgs.variant = "fn";
      callArgs.arg = args.fn;
    } else if (args.variantOrArg === "load" || args.variantOrArg === "idle") {
      callArgs.variant = args.variantOrArg;
    } else if (args.variantOrArg) {
      callArgs.variant = "selector";
      callArgs.arg = args.variantOrArg;
    } else {
      callArgs.variant = "load";
    }
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "wait", callArgs));
  }
});

// --- get group ---

function makeGetCmd(name: string, op: string, desc: string, requiresTarget = true) {
  return defineCommand({
    meta: { name, description: desc },
    args: {
      ...commonArgs,
      ...(requiresTarget ? { target: targetArg } : {}),
      pane: paneArg
    },
    async run({ args }) {
      const callArgs: Record<string, unknown> = {};
      if (requiresTarget) callArgs.target = (args as unknown as { target: string }).target;
      printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, op, callArgs));
    }
  });
}

const getCmd = defineCommand({
  meta: { name: "get", description: "Read element/page state (text/html/value/attr/box/count/url/title)" },
  subCommands: {
    text: makeGetCmd("text", "getText", "Element innerText"),
    html: makeGetCmd("html", "getHtml", "Element outerHTML"),
    value: makeGetCmd("value", "getValue", "Input value"),
    attr: defineCommand({
      meta: { name: "attr", description: "Element attribute" },
      args: {
        ...commonArgs,
        target: targetArg,
        name: { type: "positional" as const, description: "Attribute name", required: true },
        pane: paneArg
      },
      async run({ args }) {
        printJson(
          await callBrowser(toFlmuxCliFlags(args), args.pane, "getAttr", { target: args.target, name: args.name })
        );
      }
    }),
    box: makeGetCmd("box", "getBox", "Bounding rect + visibility"),
    count: makeGetCmd("count", "getCount", "Matching element count"),
    url: makeGetCmd("url", "getUrl", "Current URL", false),
    title: makeGetCmd("title", "getTitle", "Document title", false)
  } as Record<string, CommandDef>
});

// --- is group ---

const isCmd = defineCommand({
  meta: { name: "is", description: "Element state checks (visible/enabled/checked)" },
  subCommands: {
    visible: makeTargetCmd("visible", "isVisible", "Element is visible"),
    enabled: makeTargetCmd("enabled", "isEnabled", "Element is enabled"),
    checked: makeTargetCmd("checked", "isChecked", "Checkbox/aria-checked is true")
  } as Record<string, CommandDef>
});

// --- dialog group ---

const dialogCmd = defineCommand({
  meta: { name: "dialog", description: "Respond to pending dialog (alert/confirm/prompt)" },
  subCommands: {
    accept: defineCommand({
      meta: { name: "accept", description: "Accept (with optional prompt text)" },
      args: {
        ...commonArgs,
        text: { type: "positional" as const, description: "Prompt text (optional)", required: false },
        pane: paneArg
      },
      async run({ args }) {
        const callArgs: Record<string, unknown> = {};
        if (args.text) callArgs.promptText = args.text;
        printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "dialogAccept", callArgs));
      }
    }),
    dismiss: defineCommand({
      meta: { name: "dismiss", description: "Dismiss dialog" },
      args: { ...commonArgs, pane: paneArg },
      async run({ args }) {
        printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "dialogDismiss", {}));
      }
    })
  } as Record<string, CommandDef>
});

// --- console group ---

const consoleCmd = defineCommand({
  meta: { name: "console", description: "Page console buffer" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List console entries" },
      args: {
        ...commonArgs,
        pane: paneArg,
        level: { type: "string" as const, description: "log|warn|error|info|debug|all (default all)" },
        clear: { type: "boolean" as const, description: "Clear buffer after read" }
      },
      async run({ args }) {
        const callArgs: Record<string, unknown> = {};
        if (args.level) callArgs.level = args.level;
        if (args.clear) callArgs.clear = true;
        printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "consoleList", callArgs));
      }
    })
  } as Record<string, CommandDef>
});

const errorsCmd = defineCommand({
  meta: { name: "errors", description: "List page errors (console level=error)" },
  args: {
    ...commonArgs,
    pane: paneArg,
    clear: { type: "boolean" as const, description: "Clear buffer after read" }
  },
  async run({ args }) {
    const callArgs: Record<string, unknown> = {};
    if (args.clear) callArgs.clear = true;
    printJson(await callBrowser(toFlmuxCliFlags(args), args.pane, "errorsList", callArgs));
  }
});

// --- pane management ---

const listPanesCmd = defineCommand({
  meta: { name: "list", description: "List browser panes" },
  args: { ...commonArgs },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    const wsList = await apiPost<{ result: PathListResult }>(
      origin,
      "/api/model/path/list",
      { authorityClientId: clientId, path: "/status/workspaces" },
      flags
    );
    unwrap("list workspaces", wsList.result);
    const browsers: Array<{ paneId: string; url?: string; workspaceId: string }> = [];
    for (const wsEntry of wsList.result.entries ?? []) {
      const wsId = wsEntry.path.split("/").pop() ?? "";
      const paneList = await apiPost<{ result: PathListResult }>(
        origin,
        "/api/model/path/list",
        { authorityClientId: clientId, path: `${wsEntry.path}/panes` },
        flags
      );
      for (const paneEntry of paneList.result.entries ?? []) {
        const paneId = paneEntry.path.split("/").pop() ?? "";
        const kindRes = await apiPost<{ result: PathGetResult }>(
          origin,
          "/api/model/path/get",
          { authorityClientId: clientId, path: `/panes/${paneId}/kind` },
          flags
        );
        if (kindRes.result.value === "browser") {
          const urlRes = await apiPost<{ result: PathGetResult }>(
            origin,
            "/api/model/path/get",
            { authorityClientId: clientId, path: `/panes/${paneId}/browser/url` },
            flags
          );
          browsers.push({ paneId, workspaceId: wsId, url: urlRes.result.value as string | undefined });
        }
      }
    }
    printJson({ ok: true, panes: browsers });
  }
});

const focusPaneCmd = defineCommand({
  meta: { name: "focus", description: "Activate a pane" },
  args: {
    ...commonArgs,
    pane: { type: "string" as const, description: "Pane id", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    printJson(
      await apiPost(
        origin,
        "/api/model/path/call",
        {
          authorityClientId: clientId,
          path: `/panes/${args.pane}/setActive`,
          args: { source: "call" }
        },
        flags
      )
    );
  }
});

const closePaneCmd = defineCommand({
  meta: { name: "close", description: "Close a pane" },
  args: {
    ...commonArgs,
    pane: { type: "string" as const, description: "Pane id", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    printJson(
      await apiPost(
        origin,
        "/api/model/path/call",
        {
          authorityClientId: clientId,
          path: `/panes/${args.pane}/close`,
          args: {}
        },
        flags
      )
    );
  }
});

export const browserCmd: CommandDef = defineCommand({
  meta: { name: "browser", description: "Browser pane automation" },
  subCommands: {
    open: openCmd as CommandDef,
    navigate: navigateCmd as CommandDef,
    back: backCmd as CommandDef,
    reload: reloadCmd as CommandDef,
    eval: evalCmd as CommandDef,
    click: clickCmd as CommandDef,
    dblclick: dblclickCmd as CommandDef,
    hover: hoverCmd as CommandDef,
    focus: focusCmd as CommandDef,
    type: typeCmd as CommandDef,
    press: pressCmd as CommandDef,
    scroll: scrollCmd as CommandDef,
    "scroll-to": scrollToCmd as CommandDef,
    fill: fillCmd as CommandDef,
    check: checkCmd as CommandDef,
    uncheck: uncheckCmd as CommandDef,
    select: selectCmd as CommandDef,
    snapshot: snapshotCmd as CommandDef,
    find: findCmd as CommandDef,
    wait: waitCmd as CommandDef,
    get: getCmd as CommandDef,
    is: isCmd as CommandDef,
    dialog: dialogCmd as CommandDef,
    console: consoleCmd as CommandDef,
    errors: errorsCmd as CommandDef,
    highlight: highlightCmd as CommandDef,
    screenshot: screenshotCmd as CommandDef,
    capabilities: capabilitiesCmd as CommandDef,
    list: listPanesCmd as CommandDef,
    "focus-pane": focusPaneCmd as CommandDef,
    "close-pane": closePaneCmd as CommandDef
  }
}) as CommandDef;
