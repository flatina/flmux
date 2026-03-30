import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, CDPClient } from "@flatina/browser-ctl";
import { sleep } from "../lib/timers";
import type { AppRpcClient } from "../flmux/client/rpc-client";
import type { PaneId } from "../lib/ids";
import { getFlmuxStateDir } from "../lib/paths";

const BROWSER_READY_TIMEOUT_MS = 15_000;
const BROWSER_READY_RETRY_MS = 200;

export type WaitUntil = "none" | "load" | "idle";

export type BrowserWaitCommand =
  | { kind: "duration"; ms: number }
  | { kind: "load" }
  | { kind: "idle"; ms: number }
  | { kind: "target"; target?: string }
  | { kind: "text"; text: string }
  | { kind: "url"; pattern: string }
  | { kind: "fn"; expression: string };

type BrowserConnection = {
  paneId: PaneId;
  title: string;
  url: string | null;
  adapter: string;
  targetId: string;
  webSocketDebuggerUrl: string;
};

export async function snapshotBrowserPane(client: AppRpcClient, paneId: PaneId, compact: boolean): Promise<string> {
  return withConnectedBrowser(client, paneId, (browser) => browser.snapshot({ compact }));
}

export async function navigateBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  url: string,
  waitUntil: WaitUntil,
  idleMs: number
): Promise<string> {
  return withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    await browser.navigate(normalizeBrowserInput(url));
    await waitForNavigation(browser, cdpClient, waitUntil, idleMs);
    return browser.getUrl();
  });
}

export async function clickBrowserPane(client: AppRpcClient, paneId: PaneId, target: string): Promise<void> {
  await withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    const resolved = resolveTarget(getBrowserRefsPath(String(paneId)), String(paneId), target);
    if (resolved.kind === "selector") {
      const nodeId = await resolveSelectorNode(cdpClient, resolved.value);
      await callOnNode(cdpClient, nodeId, "function() { this.click(); }");
      return;
    }
    await browser.click(resolved.value);
  });
}

export async function fillBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  target: string,
  text: string
): Promise<void> {
  await withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    const resolved = resolveTarget(getBrowserRefsPath(String(paneId)), String(paneId), target);
    if (resolved.kind === "selector") {
      const nodeId = await resolveSelectorNode(cdpClient, resolved.value);
      await cdpClient.call("DOM.focus", { nodeId });
      await callOnNode(
        cdpClient,
        nodeId,
        `function() {
          const proto = this instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSet) nativeSet.call(this, ${JSON.stringify(text)});
          else this.value = ${JSON.stringify(text)};
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`
      );
      return;
    }
    await browser.fill(resolved.value, text);
  });
}

export async function pressBrowserPane(client: AppRpcClient, paneId: PaneId, key: string): Promise<void> {
  await withConnectedBrowser(client, paneId, (browser) => browser.press(key));
}

export async function waitForBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  wait: BrowserWaitCommand
): Promise<void> {
  await withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    switch (wait.kind) {
      case "duration":
        await sleep(wait.ms);
        return;
      case "load":
        await browser.waitForLoad();
        return;
      case "idle":
        await browser.waitForNetworkIdle(wait.ms);
        return;
      case "target":
        await browser.wait(wait.target ?? "");
        return;
      case "text":
        await waitForClientPredicate(
          cdpClient,
          `document.body?.innerText?.includes(${JSON.stringify(wait.text)})`,
          `Timed out waiting for text: ${wait.text}`
        );
        return;
      case "url":
        await waitForClientPredicate(
          cdpClient,
          "location.href",
          `Timed out waiting for URL: ${wait.pattern}`,
          (value) => typeof value === "string" && new Bun.Glob(wait.pattern).match(value)
        );
        return;
      case "fn":
        await waitForClientPredicate(
          cdpClient,
          `Boolean(${wait.expression})`,
          "Timed out waiting for JavaScript condition"
        );
        return;
    }
  });
}

export async function getBrowserPaneValue(
  client: AppRpcClient,
  paneId: PaneId,
  field: "url" | "title" | "text" | "html" | "value" | "attr",
  target?: string,
  name?: string
): Promise<string> {
  return withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    const resolved = target ? resolveTarget(getBrowserRefsPath(String(paneId)), String(paneId), target) : null;
    if (resolved?.kind === "selector") {
      const nodeId = await resolveSelectorNode(cdpClient, resolved.value);
      switch (field) {
        case "text":
          return callOnNode(cdpClient, nodeId, "function() { return this.textContent ?? ''; }");
        case "html":
          return callOnNode(cdpClient, nodeId, "function() { return this.innerHTML ?? ''; }");
        case "value":
          return callOnNode(cdpClient, nodeId, "function() { return this.value ?? ''; }");
        case "attr":
          return (
            (await callOnNode(
              cdpClient,
              nodeId,
              `function() { return this.getAttribute(${JSON.stringify(name ?? "")}); }`
            )) ?? ""
          );
        default:
          throw new Error(`Unsupported selector getter field: ${field}`);
      }
    }

    switch (field) {
      case "url":
        return browser.getUrl();
      case "title":
        return browser.getTitle();
      case "text":
        return browser.getText(resolved?.value ?? target ?? "");
      case "html":
        return browser.getHtml(resolved?.value ?? target ?? "");
      case "value":
        return browser.getValue(resolved?.value ?? target ?? "");
      case "attr":
        return (await browser.getAttr(resolved?.value ?? target ?? "", name ?? "")) ?? "";
    }
  });
}

export async function getBrowserPaneBox(
  client: AppRpcClient,
  paneId: PaneId,
  target: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  return withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    const resolved = resolveTarget(getBrowserRefsPath(String(paneId)), String(paneId), target);
    if (resolved.kind === "selector") {
      const nodeId = await resolveSelectorNode(cdpClient, resolved.value);
      return getBoxModel(cdpClient, nodeId);
    }
    return browser.getBox(resolved.value);
  });
}

export async function evalBrowserPane(client: AppRpcClient, paneId: PaneId, script: string): Promise<unknown> {
  return withConnectedBrowser(client, paneId, (browser) => browser.eval(script));
}

export async function backBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  waitUntil: WaitUntil,
  idleMs: number
): Promise<string> {
  return runHistoryAction(client, paneId, (browser) => browser.back(), waitUntil, idleMs, true);
}

export async function forwardBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  waitUntil: WaitUntil,
  idleMs: number
): Promise<string> {
  return runHistoryAction(client, paneId, (browser) => browser.forward(), waitUntil, idleMs, true);
}

export async function reloadBrowserPane(
  client: AppRpcClient,
  paneId: PaneId,
  waitUntil: WaitUntil,
  idleMs: number
): Promise<string> {
  return runHistoryAction(client, paneId, (browser) => browser.reload(), waitUntil, idleMs, false);
}

async function runHistoryAction(
  client: AppRpcClient,
  paneId: PaneId,
  action: (browser: Browser) => Promise<void>,
  waitUntil: WaitUntil,
  idleMs: number,
  requireUrlChange: boolean
): Promise<string> {
  return withConnectedBrowser(client, paneId, async (browser, cdpClient) => {
    const previousUrl = requireUrlChange ? await browser.getUrl() : null;
    await action(browser);
    await waitForNavigation(browser, cdpClient, waitUntil, idleMs, previousUrl);
    return browser.getUrl();
  });
}

async function withConnectedBrowser<T>(
  client: AppRpcClient,
  paneId: PaneId,
  run: (browser: Browser, cdpClient: CDPClient, connection: BrowserConnection) => Promise<T>
): Promise<T> {
  const connection = await resolveBrowserConnection(client, paneId);
  const cdpClient = await CDPClient.connect(connection.webSocketDebuggerUrl);
  const browser = new Browser(cdpClient, String(paneId), getBrowserRefsPath(String(paneId)));
  try {
    return await run(browser, cdpClient, connection);
  } finally {
    await cdpClient.close();
  }
}

async function resolveBrowserConnection(client: AppRpcClient, paneId: PaneId): Promise<BrowserConnection> {
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
      return {
        paneId,
        title: propertyAsString(properties, "title") ?? "Browser",
        url: propertyAsNullableString(properties, "browser.url"),
        adapter,
        targetId,
        webSocketDebuggerUrl
      };
    }

    await sleep(BROWSER_READY_RETRY_MS);
  }

  const appProperties = await listAppProperties(client);
  if (!propertyAsString(appProperties, "browser.cdpBaseUrl")) {
    throw new Error("CDP target discovery is not available");
  }

  throw new Error(`Browser pane ${paneId} did not become automation-ready in time`);
}

async function waitForNavigation(
  browser: Browser,
  cdpClient: CDPClient,
  waitUntil: WaitUntil,
  idleMs: number,
  previousUrl?: string | null
): Promise<void> {
  if (waitUntil === "load") {
    await browser.waitForLoad();
  } else if (waitUntil === "idle") {
    await browser.waitForNetworkIdle(idleMs);
  }

  if (previousUrl) {
    await waitForClientPredicate(
      cdpClient,
      "location.href",
      `Timed out waiting for URL change from ${previousUrl}`,
      (value) => typeof value === "string" && value !== previousUrl
    );
  }
}

async function waitForClientPredicate(
  client: CDPClient,
  expression: string,
  timeoutMessage: string,
  matcher: (value: unknown) => boolean = Boolean
): Promise<void> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await client.evalJS(expression);
    if (matcher(value)) {
      return;
    }
    await sleep(BROWSER_READY_RETRY_MS);
  }
  throw new Error(timeoutMessage);
}

async function listPaneProperties(client: AppRpcClient, paneId: PaneId): Promise<Map<string, unknown>> {
  const result = await client.call("props.list", { scope: "pane", targetId: paneId }, BROWSER_READY_TIMEOUT_MS);
  return new Map(Object.entries(result.values));
}

async function listAppProperties(client: AppRpcClient): Promise<Map<string, unknown>> {
  const result = await client.call("props.list", { scope: "app" }, BROWSER_READY_TIMEOUT_MS);
  return new Map(Object.entries(result.values));
}

function propertyAsString(properties: Map<string, unknown>, key: string): string | null {
  const value = properties.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function propertyAsNullableString(properties: Map<string, unknown>, key: string): string | null {
  const value = properties.get(key);
  return typeof value === "string" ? value : null;
}

function propertyAsBoolean(properties: Map<string, unknown>, key: string): boolean {
  return properties.get(key) === true;
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

function getBrowserRefsPath(paneId: string): string {
  const dir = join(getFlmuxStateDir(), "browser-refs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${paneId}.json`);
}

type RefRecord = {
  backendDOMNodeId: number;
  role: string;
  name: string;
};

type RefsFile = {
  version: 1;
  targets: Record<
    string,
    {
      next: number;
      refs: Record<string, RefRecord>;
    }
  >;
};

type ResolvedTarget = { kind: "ref"; value: string } | { kind: "selector"; value: string };

function resolveTarget(refsPath: string, targetKey: string, raw: string): ResolvedTarget {
  if (isSelectorTarget(raw)) {
    return { kind: "selector", value: raw };
  }

  if (raw.startsWith("@")) {
    return { kind: "ref", value: raw };
  }

  const refs = loadRefs(refsPath).targets[targetKey]?.refs ?? {};
  if (raw.startsWith("label=")) {
    const name = raw.slice("label=".length);
    const match = findRef(
      refs,
      (record) => record.name === name && ["textbox", "searchbox", "combobox"].includes(record.role)
    );
    if (match) {
      return { kind: "ref", value: match };
    }
    throw new Error(`Locator "${raw}" not found in snapshot refs. Run \`flweb snapshot\` first.`);
  }
  if (raw.startsWith("text=")) {
    const name = raw.slice("text=".length);
    const match = findRef(refs, (record) => record.name === name);
    if (match) {
      return { kind: "ref", value: match };
    }
    throw new Error(`Locator "${raw}" not found in snapshot refs. Run \`flweb snapshot\` first.`);
  }
  if (raw.startsWith("role=")) {
    const parsed = parseRoleLocator(raw);
    if (parsed) {
      const match = findRef(
        refs,
        (record) => record.role === parsed.role && (!parsed.name || record.name === parsed.name)
      );
      if (match) {
        return { kind: "ref", value: match };
      }
    }
    throw new Error(`Locator "${raw}" not found in snapshot refs. Run \`flweb snapshot\` first.`);
  }

  return { kind: "selector", value: raw };
}

function loadRefs(refsPath: string): RefsFile {
  try {
    return JSON.parse(readFileSync(refsPath, "utf-8")) as RefsFile;
  } catch {
    return { version: 1, targets: {} };
  }
}

function findRef(refs: Record<string, RefRecord>, matcher: (record: RefRecord) => boolean): string | null {
  for (const [ref, record] of Object.entries(refs)) {
    if (matcher(record)) {
      return ref;
    }
  }
  return null;
}

function parseRoleLocator(raw: string): { role: string; name: string | null } | null {
  const match = /^role=([^[]+)(?:\[name=['"](.+)['"]\])?$/.exec(raw);
  if (!match) {
    return null;
  }
  return {
    role: match[1] ?? "",
    name: match[2] ?? null
  };
}

function isSelectorTarget(raw: string): boolean {
  return raw.startsWith("#") || raw.startsWith(".") || raw.startsWith("[") || raw.startsWith("xpath=");
}

async function resolveSelectorNode(client: CDPClient, selector: string): Promise<number> {
  if (selector.startsWith("xpath=")) {
    const xpath = selector.slice(6);
    const evaluated = await client.call("Runtime.evaluate", {
      expression: `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
      returnByValue: false
    });
    const objectId = evaluated.result?.objectId;
    if (!objectId) {
      throw new Error(`XPath "${xpath}" not found`);
    }
    try {
      const requested = await client.call("DOM.requestNode", { objectId });
      if (!requested.nodeId) {
        throw new Error(`XPath "${xpath}" could not resolve to DOM node`);
      }
      return requested.nodeId;
    } finally {
      void client.call("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  const documentNode = await client.call("DOM.getDocument", {});
  const result = await client.call("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector
  });
  if (!result.nodeId) {
    throw new Error(`Selector "${selector}" not found`);
  }
  return result.nodeId;
}

async function callOnNode(client: CDPClient, nodeId: number, fn: string): Promise<any> {
  const resolved = await client.call("DOM.resolveNode", { nodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error("Could not resolve node to JS object");
  }
  try {
    const result = await client.call("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "callFunctionOn failed");
    }
    return result.result?.value;
  } finally {
    void client.call("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function getBoxModel(
  client: CDPClient,
  nodeId: number
): Promise<{ x: number; y: number; width: number; height: number }> {
  const result = await client.call("DOM.getBoxModel", { nodeId });
  const quad = result.model?.content ?? result.model?.border;
  if (!quad || quad.length < 8) {
    throw new Error("No box model for node");
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY
  };
}
