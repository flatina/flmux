import { CDPClient } from "@flatina/browser-ctl";
import type { ExtensionCliCommand } from "flmux-sdk";

const BROWSER_RPC_TIMEOUT_MS = 20_000;
const BROWSER_READY_TIMEOUT_MS = 15_000;
const BROWSER_READY_RETRY_MS = 200;

type BrowserConnection = {
  paneId: string;
  title: string;
  url: string | null;
  adapter: string;
  targetId: string;
  webSocketDebuggerUrl: string;
};

export const command: ExtensionCliCommand = {
  meta: { name: "browser", description: "Manage flmux browser panes" },
  subCommands: {
    new: {
      meta: { name: "new", description: "Create a new browser pane" },
      args: {
        session: { type: "string", description: "Target session ID" },
        json: { type: "boolean", description: "Print JSON output" },
        url: { type: "positional", description: "Initial URL" },
        placement: {
          type: "string",
          description: "Browser placement: auto, within, left, right, above, below",
          default: "auto"
        }
      },
      run: async ({ args, getClient, output }) => {
        const client = await getClient(args.session as string | undefined);
        const placement = normalizePlacement(args.placement);
        const senderPaneId = resolveSenderPaneId();
        const placementResult = await resolveBrowserPlacement(client, placement, senderPaneId);
        const result = (await client.call(
          "pane.open",
          {
            leaf: { kind: "browser", url: normalizeBrowserInput(String(args.url ?? "")) },
            referencePaneId: placementResult.referencePaneId,
            direction: placementResult.direction
          },
          BROWSER_RPC_TIMEOUT_MS
        )) as { ok: true; paneId: string; activePaneId?: string | null };

        await waitForBrowserConnection(client, result.paneId);

        if (args.json) {
          output(result);
          return;
        }
        console.log(result.paneId);
      }
    },
    list: {
      meta: { name: "list", description: "List browser panes" },
      args: {
        session: { type: "string", description: "Target session ID" },
        json: { type: "boolean", description: "Print JSON output" }
      },
      run: async ({ args, getClient, output }) => {
        const client = await getClient(args.session as string | undefined);
        const summary = (await client.call("app.summary", undefined, BROWSER_RPC_TIMEOUT_MS)) as {
          activePaneId: string | null;
          panes: Array<{ paneId: string; tabId: string; title: string; kind: string; url?: string; adapter?: string; ageMs?: number; openerPaneId?: string }>;
        };
        const panes = summary.panes
          .filter((pane) => pane.kind === "browser")
          .map((pane) => ({
            paneId: pane.paneId,
            isActive: pane.paneId === summary.activePaneId,
            url: pane.url ?? null,
            age: formatAge(pane.ageMs),
            openerPaneId: pane.openerPaneId ?? null
          }))
          .sort((a, b) => {
            if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
            return 0;
          });
        if (args.json) {
          output({ ok: true, panes });
          return;
        }
        if (panes.length === 0) {
          console.log("No browser panes.");
          return;
        }
        console.log(["PANE_ID", "ACTIVE", "AGE", "OPENER", "URL"].join("\t"));
        for (const pane of panes) {
          console.log([pane.paneId, pane.isActive ? "*" : "", pane.age, pane.openerPaneId ?? "", pane.url ?? ""].join("\t"));
        }
      }
    },
    focus: {
      meta: { name: "focus", description: "Focus a browser pane" },
      args: {
        session: { type: "string", description: "Target session ID" },
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args, getClient, output }) => {
        const client = await getClient(args.session as string | undefined);
        const result = (await client.call(
          "pane.focus",
          { paneId: await resolveBrowserPaneId(client, args.pane as string | undefined) },
          BROWSER_RPC_TIMEOUT_MS
        )) as { ok: true; paneId: string; activePaneId?: string | null };
        if (args.json) {
          output(result);
          return;
        }
        console.log(result.paneId);
      }
    },
    close: {
      meta: { name: "close", description: "Close a browser pane" },
      args: {
        session: { type: "string", description: "Target session ID" },
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args, getClient, output }) => {
        const client = await getClient(args.session as string | undefined);
        const result = (await client.call(
          "pane.close",
          { paneId: await resolveBrowserPaneId(client, args.pane as string | undefined) },
          BROWSER_RPC_TIMEOUT_MS
        )) as { ok: true; paneId: string; activePaneId?: string | null };
        if (args.json) {
          output(result);
          return;
        }
        console.log(result.paneId);
      }
    },
    connect: {
      meta: { name: "connect", description: "Validate that a browser pane is automation-ready" },
      args: {
        session: { type: "string", description: "Target session ID" },
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args, getClient, output }) => {
        const client = await getClient(args.session as string | undefined);
        const paneId = await resolveBrowserPaneId(client, args.pane as string | undefined);
        const connection = await waitForBrowserConnection(client, paneId);
        const result = {
          ok: true,
          paneId,
          url: connection.url,
          title: connection.title,
          adapter: connection.adapter,
          targetId: connection.targetId
        };
        if (args.json) {
          output(result);
          return;
        }
        console.log(result.paneId);
      }
    }
  }
};

async function resolveBrowserPlacement(
  client: { call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> },
  placement: "auto" | "within" | "left" | "right" | "above" | "below",
  senderPaneId?: string
): Promise<{ referencePaneId?: string; direction?: "within" | "left" | "right" | "above" | "below" }> {
  if (!senderPaneId) {
    return {};
  }

  if (placement !== "auto") {
    return {
      referencePaneId: senderPaneId,
      direction: placement
    };
  }

  const props = await listPaneProperties(client, senderPaneId);
  if (propertyAsString(props, "kind") !== "terminal") {
    return {
      referencePaneId: senderPaneId,
      direction: "right"
    };
  }

  const cols = propertyAsNumber(props, "terminal.cols");
  const rows = propertyAsNumber(props, "terminal.rows");
  return {
    referencePaneId: senderPaneId,
    direction: cols !== null && rows !== null && cols >= rows * 1.2 ? "right" : "above"
  };
}

async function waitForBrowserConnection(
  client: { call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> },
  paneId: string
): Promise<BrowserConnection> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const properties = await listPaneProperties(client, paneId);
    const kind = propertyAsString(properties, "kind");
    if (!kind) {
      throw new Error(`Pane not found: ${paneId}`);
    }
    if (kind !== "browser") {
      throw new Error(`Pane ${paneId} is not a browser pane`);
    }

    const adapter = propertyAsString(properties, "browser.adapter") ?? "electrobun-native";
    if (adapter !== "electrobun-native") {
      throw new Error(`Browser pane ${paneId} is not automatable`);
    }

    const targetId = propertyAsString(properties, "browser.cdp.targetId");
    const webSocketDebuggerUrl = propertyAsString(properties, "browser.cdp.webSocketDebuggerUrl");
    const ready = propertyAsBoolean(properties, "browser.cdp.ready");
    if (ready && targetId && webSocketDebuggerUrl) {
      const details = await readBrowserTargetDetails(webSocketDebuggerUrl);
      return {
        paneId,
        title: details.title,
        url: details.url,
        adapter,
        targetId,
        webSocketDebuggerUrl
      };
    }

    const appProperties = await listAppProperties(client);
    if (!propertyAsString(appProperties, "browser.cdpBaseUrl")) {
      throw new Error("CDP target discovery is not available");
    }

    await sleep(BROWSER_READY_RETRY_MS);
  }

  throw new Error(`Browser pane ${paneId} did not become automation-ready in time`);
}

async function readBrowserTargetDetails(webSocketDebuggerUrl: string): Promise<{ url: string | null; title: string }> {
  const client = await CDPClient.connect(webSocketDebuggerUrl, ["Runtime"]);
  try {
    const [url, title] = await Promise.all([client.evalJS("window.location.href"), client.evalJS("document.title")]);
    return {
      url: typeof url === "string" ? url : null,
      title: typeof title === "string" ? title : ""
    };
  } finally {
    await client.close();
  }
}

async function listPaneProperties(
  client: { call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> },
  paneId: string
): Promise<Map<string, unknown>> {
  const result = (await client.call(
    "props.list",
    { scope: "pane", targetId: paneId },
    BROWSER_RPC_TIMEOUT_MS
  )) as { values: Record<string, unknown> };
  return new Map(Object.entries(result.values));
}

async function listAppProperties(
  client: { call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> }
): Promise<Map<string, unknown>> {
  const result = (await client.call("props.list", { scope: "app" }, BROWSER_RPC_TIMEOUT_MS)) as {
    values: Record<string, unknown>;
  };
  return new Map(Object.entries(result.values));
}

function propertyAsString(properties: Map<string, unknown>, key: string): string | null {
  const value = properties.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function propertyAsNumber(properties: Map<string, unknown>, key: string): number | null {
  const value = properties.get(key);
  return typeof value === "number" ? value : null;
}

function propertyAsBoolean(properties: Map<string, unknown>, key: string): boolean {
  return properties.get(key) === true;
}

function formatAge(ageMs?: number): string {
  if (typeof ageMs !== "number") return "";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function normalizePlacement(
  value: unknown
): "auto" | "within" | "left" | "right" | "above" | "below" {
  return value === "within" || value === "left" || value === "right" || value === "above" || value === "below"
    ? value
    : "auto";
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "about:blank";
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("about:")) {
    return trimmed;
  }

  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

async function resolveBrowserPaneId(client: { call: (method: string, params: unknown, timeout?: number) => Promise<unknown> }, value?: string): Promise<string> {
  const raw = value?.trim() || process.env.FLMUX_BROWSER?.trim();
  if (raw) return raw;

  const summary = (await client.call("app.summary", undefined)) as {
    activePaneId: string | null;
    panes: Array<{ paneId: string; kind: string; ageMs?: number }>;
  };
  const browserPanes = summary.panes.filter((p) => p.kind === "browser");
  if (browserPanes.length === 0) {
    throw new Error("No browser pane found. Create one first:\n  flmux browser new https://example.com");
  }
  if (summary.activePaneId) {
    const active = browserPanes.find((p) => p.paneId === summary.activePaneId);
    if (active) return active.paneId;
  }
  const sorted = browserPanes.filter((p) => typeof p.ageMs === "number").sort((a, b) => (a.ageMs ?? 0) - (b.ageMs ?? 0));
  if (sorted.length > 0) return sorted[0]!.paneId;
  if (browserPanes.length === 1) return browserPanes[0]!.paneId;
  throw new Error(`${browserPanes.length} browser panes found, none active. Pass --pane <paneId>.`);
}

function resolveSenderPaneId(value?: string): string | undefined {
  const raw = value?.trim() || process.env.FLMUX_PANE_ID?.trim();
  return raw || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
