import { CDPClient, sleep } from "@flatina/browser-ctl/cdp";
import type {
  BrowserConnectParams,
  BrowserConnectResult,
  BrowserGetParams,
  BrowserGetResult,
  BrowserNavigateParams,
  BrowserNavigateResult,
  BrowserNewParams,
  BrowserPaneResult,
  BrowserPaneInfo,
  BrowserSnapshotParams,
  BrowserSnapshotResult
} from "../shared/app-rpc";

type BrowserWorkspace = {
  browserNew(params: BrowserNewParams): Promise<BrowserPaneResult>;
  listBrowserPanes(): Promise<{ ok: true; panes: BrowserPaneInfo[] }>;
  getBrowserTargets(): Promise<{
    ok: true;
    cdpBaseUrl: string | null;
    targets: Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }>;
  }>;
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "textbox",
  "link",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
  "listbox"
]);

const PANE_MARKER_PREFIX = "__FLMUX_PANE__:";
const DEFAULT_AUTOMATION_BLANK_URL = "about:blank#flmux-browser";

export async function browserNew(workspace: BrowserWorkspace, params: BrowserNewParams): Promise<BrowserPaneResult> {
  const created = await workspace.browserNew({
    url: params.url?.trim().length ? normalizeAutomationUrl(params.url) : DEFAULT_AUTOMATION_BLANK_URL
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await browserConnect(workspace, { paneId: created.paneId });
    if (result.ok) {
      return created;
    }
    if (result.code === "unsupported_adapter" || result.code === "pane_not_found") {
      throw new Error(result.error);
    }
    await sleep(200);
  }

  throw new Error(`Browser pane ${created.paneId} did not become automation-ready in time`);
}

export async function browserConnect(
  workspace: BrowserWorkspace,
  params: BrowserConnectParams
): Promise<BrowserConnectResult> {
  const { panes } = await workspace.listBrowserPanes();
  const pane = panes.find((candidate) => candidate.paneId === params.paneId);
  if (!pane) {
    return {
      ok: false,
      paneId: params.paneId,
      code: "pane_not_found",
      error: `Browser pane not found: ${params.paneId}`
    };
  }

  if (pane.adapter !== "electrobun-native") {
    return {
      ok: false,
      paneId: params.paneId,
      code: "unsupported_adapter",
      error: `Browser pane ${params.paneId} is using adapter ${pane.adapter}, which is not automatable`
    };
  }

  if (pane.automationStatus !== "ready") {
    return {
      ok: false,
      paneId: params.paneId,
      code: "pane_not_ready",
      error: pane.automationReason ?? `Browser pane ${params.paneId} is not automation-ready yet`
    };
  }

  const targetsResult = await workspace.getBrowserTargets();
  if (!targetsResult.cdpBaseUrl) {
    return {
      ok: false,
      paneId: params.paneId,
      code: "cdp_unavailable",
      error: "No CDP endpoint is available for browser automation"
    };
  }

  const pageTargets = targetsResult.targets.filter((target) => !target.url.startsWith("views://"));
  const orderedTargets = orderTargetsByHint(pageTargets, pane.url);
  const marker = `${PANE_MARKER_PREFIX}${pane.paneId}`;
  for (const target of orderedTargets) {
    const matched = await targetMatchesMarker(target.webSocketDebuggerUrl, marker);
    if (!matched) continue;
    return {
      ok: true,
      paneId: pane.paneId,
      url: pane.url,
      title: pane.title,
      cdpBaseUrl: targetsResult.cdpBaseUrl,
      targetId: target.id,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    };
  }

  return {
    ok: false,
    paneId: pane.paneId,
    code: pageTargets.length <= 1 ? "target_not_found" : "target_ambiguous",
    error:
      pageTargets.length <= 1
        ? `No live CDP target found for browser pane ${pane.paneId}`
        : `Could not uniquely map browser pane ${pane.paneId} to a live CDP target`,
    candidates: pageTargets.map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url
    }))
  };
}

export async function browserNavigate(
  workspace: BrowserWorkspace,
  params: BrowserNavigateParams
): Promise<BrowserNavigateResult> {
  const connection = await requireConnectedTarget(workspace, params.paneId);
  const client = await CDPClient.connect(connection.webSocketDebuggerUrl);

  try {
    const url = normalizeAutomationUrl(params.url);
    const result = await client.call<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    const waitUntil = params.waitUntil ?? "load";
    if (waitUntil === "load") {
      await waitForLoad(client);
    } else if (waitUntil === "idle") {
      await waitForNetworkIdle(client, params.idleMs ?? 500);
    }

    return {
      ok: true,
      paneId: params.paneId,
      url
    };
  } finally {
    await client.close();
  }
}

export async function browserGet(workspace: BrowserWorkspace, params: BrowserGetParams): Promise<BrowserGetResult> {
  const connection = await requireConnectedTarget(workspace, params.paneId);
  const client = await CDPClient.connect(connection.webSocketDebuggerUrl);

  try {
    const expression = params.field === "url" ? "window.location.href" : "document.title";
    const value = await client.evalJS(expression);
    return {
      ok: true,
      paneId: params.paneId,
      field: params.field,
      value: typeof value === "string" ? value : String(value ?? "")
    };
  } finally {
    await client.close();
  }
}

export async function browserSnapshot(
  workspace: BrowserWorkspace,
  params: BrowserSnapshotParams
): Promise<BrowserSnapshotResult> {
  const connection = await requireConnectedTarget(workspace, params.paneId);
  const client = await CDPClient.connect(connection.webSocketDebuggerUrl);

  try {
    const snapshot = await buildTransientSnapshot(client, { compact: params.compact ?? false });
    return {
      ok: true,
      paneId: params.paneId,
      snapshot
    };
  } finally {
    await client.close();
  }
}

async function requireConnectedTarget(workspace: BrowserWorkspace, paneId: BrowserConnectParams["paneId"]) {
  const result = await browserConnect(workspace, { paneId });
  if (!result.ok) {
    const error = new Error(result.error) as Error & {
      code?: string;
      candidates?: Array<{ id: string; title: string; url: string }>;
    };
    error.code = result.code;
    error.candidates = result.candidates;
    throw error;
  }
  return result;
}

function normalizeAutomationUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    return "about:blank";
  }

  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("about:")) {
    return value;
  }

  if (value.includes(".") && !value.includes(" ")) {
    return `https://${value}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function orderTargetsByHint(
  targets: Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }>,
  urlHint: string | null
): Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }> {
  if (!urlHint || urlHint === "about:blank") {
    return targets;
  }

  const exact = targets.filter((target) => target.url === urlHint);
  const rest = targets.filter((target) => target.url !== urlHint);
  return [...exact, ...rest];
}

async function targetMatchesMarker(wsUrl: string, marker: string): Promise<boolean> {
  const client = await CDPClient.connect(wsUrl, ["Runtime"]);
  try {
    const value = await client.evalJS("window.name");
    return value === marker;
  } catch {
    return false;
  } finally {
    await client.close();
  }
}

async function buildTransientSnapshot(client: CDPClient, options?: { compact?: boolean }): Promise<string> {
  const response = await client.call<{ nodes?: Array<Record<string, unknown>> }>("Accessibility.getFullAXTree", {}, 10_000);
  const nodes = response.nodes ?? [];
  const lines: string[] = [];
  let counter = 0;

  for (const node of nodes) {
    const role = getStringValue(node.role);
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    if (node.ignored || node.backendDOMNodeId == null) continue;

    const name = getStringValue(node.name) ?? "";
    const value = getPropertyValue(node.properties, "value");
    const valueStr = typeof value === "string" ? value : "";
    if (options?.compact && !name && !valueStr) continue;

    counter += 1;
    let line = `@e${counter} ${role}`;
    if (name) line += ` "${name}"`;
    if (valueStr.length > 0) line += ` value="${valueStr}"`;
    const checked = getPropertyValue(node.properties, "checked");
    const disabled = getPropertyValue(node.properties, "disabled");
    if (checked === true || checked === "true") line += " [checked]";
    if (disabled) line += " [disabled]";
    lines.push(line);
  }

  return lines.length ? lines.join("\n") : "(no interactive elements found)";
}

function getStringValue(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const value = (candidate as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

function getPropertyValue(properties: unknown, name: string): unknown {
  if (!Array.isArray(properties)) {
    return undefined;
  }

  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    if ((property as { name?: unknown }).name !== name) continue;
    return (property as { value?: { value?: unknown } }).value?.value;
  }

  return undefined;
}

async function waitForLoad(client: CDPClient, timeoutMs = 30_000): Promise<void> {
  const state = await client.evalJS("document.readyState");
  if (state === "complete") {
    return;
  }
  await client.once("Page.loadEventFired", timeoutMs);
}

async function waitForNetworkIdle(client: CDPClient, idleMs = 500, timeoutMs = 30_000): Promise<void> {
  try {
    await client.call("Network.enable", {}, 3000);
  } catch {
    // ignore
  }

  let inflight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("waitForNetworkIdle timed out"));
    }, timeoutMs);

    const checkIdle = () => {
      if (inflight <= 0) {
        idleTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, idleMs);
      }
    };

    const onRequest = () => {
      inflight += 1;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const onDone = () => {
      inflight = Math.max(0, inflight - 1);
      checkIdle();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      if (idleTimer) clearTimeout(idleTimer);
      client.off("Network.requestWillBeSent", onRequest);
      client.off("Network.loadingFinished", onDone);
      client.off("Network.loadingFailed", onDone);
    };

    client.on("Network.requestWillBeSent", onRequest);
    client.on("Network.loadingFinished", onDone);
    client.on("Network.loadingFailed", onDone);
    checkIdle();
  });
}
