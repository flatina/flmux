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
          panes: Array<{ paneId: string; tabId: string; title: string; kind: string; url?: string; adapter?: string }>;
        };
        const panes = summary.panes
          .filter((pane) => pane.kind === "browser")
          .map((pane) => ({
            paneId: pane.paneId,
            tabId: pane.tabId,
            title: pane.title,
            url: pane.url ?? null,
            adapter: pane.adapter ?? "electrobun-native"
          }));
        const result = { ok: true, panes };
        if (args.json) {
          output(result);
          return;
        }
        printPaneIds(panes.map((pane) => pane.paneId));
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
          { paneId: resolveBrowserPaneId(args.pane as string | undefined) },
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
          { paneId: resolveBrowserPaneId(args.pane as string | undefined) },
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
        const paneId = resolveBrowserPaneId(args.pane as string | undefined);
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

function resolveBrowserPaneId(value?: string): string {
  const raw = value?.trim() || process.env.FLMUX_BROWSER?.trim();
  if (!raw) {
    throw new Error(
      [
        "No browser pane selected.",
        "Set FLMUX_BROWSER first:",
        "  export FLMUX_BROWSER=$(flmux browser new https://example.com)",
        "",
        "Or pass a pane explicitly:",
        "  flweb snapshot --pane browser.1a2b3c4d"
      ].join("\n")
    );
  }

  return raw;
}

function resolveSenderPaneId(value?: string): string | undefined {
  const raw = value?.trim() || process.env.FLMUX_PANE_ID?.trim();
  return raw || undefined;
}

function printPaneIds(paneIds: string[]): void {
  for (const paneId of paneIds) {
    console.log(paneId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
