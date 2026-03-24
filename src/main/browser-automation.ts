import { BrowserView } from "electrobun/bun";
import { sleep } from "@flatina/browser-ctl/cdp";
import type {
  BrowserActionResult,
  BrowserBoxParams,
  BrowserBoxResult,
  BrowserClickParams,
  BrowserConnectParams,
  BrowserConnectErrorCode,
  BrowserConnectResult,
  BrowserEvalParams,
  BrowserEvalResult,
  BrowserFillParams,
  BrowserGetParams,
  BrowserGetResult,
  BrowserNavigateParams,
  BrowserNavigateResult,
  BrowserNewParams,
  BrowserPaneInfo,
  BrowserPaneResult,
  BrowserPageActionParams,
  BrowserPressParams,
  BrowserSnapshotParams,
  BrowserSnapshotResult,
  BrowserWaitParams
} from "../shared/app-rpc";

type BrowserWorkspace = {
  browserNew(params: BrowserNewParams): Promise<BrowserPaneResult>;
  listBrowserPanes(): Promise<{ ok: true; panes: BrowserPaneInfo[] }>;
};

const DEFAULT_AUTOMATION_BLANK_URL = "about:blank#flmux-browser";
const BROWSER_POLL_TIMEOUT_MS = 15_000;

type BrowserConnectSuccess = Extract<BrowserConnectResult, { ok: true }>;

class BrowserAutomationError extends Error {
  constructor(
    readonly code: BrowserConnectErrorCode,
    message: string
  ) {
    super(message);
  }
}

export async function browserNew(workspace: BrowserWorkspace, params: BrowserNewParams): Promise<BrowserPaneResult> {
  const created = await workspace.browserNew({
    url: params.url?.trim().length ? normalizeAutomationUrl(params.url) : DEFAULT_AUTOMATION_BLANK_URL
  });

  await pollUntil(
    async () => {
      const result = await tryConnect(workspace, created.paneId);
      if (result.ok) {
        return true;
      }
      if (result.code === "pane_not_ready") {
        return null;
      }
      throw new Error(result.error);
    },
    `Browser pane ${created.paneId} did not become automation-ready in time`,
    200
  );

  return created;
}

export async function browserConnect(
  workspace: BrowserWorkspace,
  params: BrowserConnectParams
): Promise<BrowserConnectResult> {
  return tryConnect(workspace, params.paneId);
}

export async function browserNavigate(
  workspace: BrowserWorkspace,
  params: BrowserNavigateParams
): Promise<BrowserNavigateResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const url = normalizeAutomationUrl(params.url);
  pane.view.loadURL(url);
  await waitForPaneReady(workspace, params.paneId, params.waitUntil ?? "load", params.idleMs ?? 500, url);

  return {
    ok: true,
    paneId: params.paneId,
    url
  };
}

export async function browserGet(workspace: BrowserWorkspace, params: BrowserGetParams): Promise<BrowserGetResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const expression =
    params.field === "url"
      ? "return window.location.href"
      : params.field === "title"
        ? "return document.title"
        : params.field === "text"
          ? `const el = ${buildResolveTargetExpression(params.target ?? "")}; if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target ?? "")}"); return (el.innerText || el.textContent || "").trim();`
          : params.field === "html"
            ? `const el = ${buildResolveTargetExpression(params.target ?? "")}; if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target ?? "")}"); return el.innerHTML;`
            : params.field === "value"
              ? `const el = ${buildResolveTargetExpression(params.target ?? "")}; if (!(el instanceof HTMLElement) || !('value' in el)) throw new Error("Target is not readable as value: ${escapeJs(params.target ?? "")}"); return String(el.value ?? "");`
              : `const el = ${buildResolveTargetExpression(params.target ?? "")}; if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target ?? "")}"); return el.getAttribute(${JSON.stringify(params.name ?? "")}) ?? "";`;
  const value = await evaluateInWebview<string>(pane.view, expression);
  return { ok: true, paneId: params.paneId, field: params.field, value };
}

export async function browserBox(workspace: BrowserWorkspace, params: BrowserBoxParams): Promise<BrowserBoxResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const box = await evaluateInWebview<{ x: number; y: number; width: number; height: number }>(
    pane.view,
    `const el = ${buildResolveTargetExpression(params.target)};
     if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target)}");
     const rect = el.getBoundingClientRect();
     return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };`
  );
  return { ok: true, paneId: params.paneId, box };
}

export async function browserSnapshot(
  workspace: BrowserWorkspace,
  params: BrowserSnapshotParams
): Promise<BrowserSnapshotResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const snapshot = await evaluateInWebview<string>(pane.view, buildSnapshotScript(!!params.compact));
  return { ok: true, paneId: params.paneId, snapshot };
}

export async function browserClick(workspace: BrowserWorkspace, params: BrowserClickParams): Promise<BrowserActionResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  await evaluateInWebview(pane.view, `
    const el = ${buildResolveTargetExpression(params.target)};
    if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target)}");
    setTimeout(() => el.click(), 0);
    return true;
  `);
  return { ok: true, paneId: params.paneId };
}

export async function browserFill(workspace: BrowserWorkspace, params: BrowserFillParams): Promise<BrowserActionResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  await evaluateInWebview(pane.view, `
    const el = ${buildResolveTargetExpression(params.target)};
    if (!(el instanceof HTMLElement)) throw new Error("Target not found: ${escapeJs(params.target)}");
    if (!('value' in el)) throw new Error("Target is not fillable: ${escapeJs(params.target)}");
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSet) nativeSet.call(el, ${JSON.stringify(params.text)});
    else el.value = ${JSON.stringify(params.text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  return { ok: true, paneId: params.paneId };
}

export async function browserPress(workspace: BrowserWorkspace, params: BrowserPressParams): Promise<BrowserActionResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  await evaluateInWebview(pane.view, `
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const init = { key: ${JSON.stringify(params.key)}, bubbles: true, cancelable: true };
    setTimeout(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    }, 0);
    return true;
  `);
  return { ok: true, paneId: params.paneId };
}

export async function browserWait(workspace: BrowserWorkspace, params: BrowserWaitParams): Promise<BrowserActionResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);

  if (params.kind === "duration") {
    await sleep(params.ms ?? 0);
  } else if (params.kind === "load") {
    await waitForWebviewLoad(pane.view, 0, false);
  } else if (params.kind === "idle") {
    await waitForWebviewLoad(pane.view, params.ms ?? 500, true);
  } else if (params.kind === "text") {
    await waitForText(pane.view, params.text ?? "");
  } else if (params.kind === "url") {
    await waitForUrl(pane.view, params.pattern ?? "");
  } else if (params.kind === "fn") {
    await waitForFunction(pane.view, params.expression ?? "");
  } else {
    await waitForTarget(pane.view, params.target ?? "");
  }

  return { ok: true, paneId: params.paneId };
}

export async function browserEval(workspace: BrowserWorkspace, params: BrowserEvalParams): Promise<BrowserEvalResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const script = params.script.trim().startsWith("return ") ? params.script : `return (${params.script})`;
  const value = await evaluateInWebview<unknown>(pane.view, script);
  return { ok: true, paneId: params.paneId, value };
}

export async function browserBack(
  workspace: BrowserWorkspace,
  params: BrowserPageActionParams
): Promise<BrowserNavigateResult> {
  return runHistoryAction(workspace, params, "window.history.back()");
}

export async function browserForward(
  workspace: BrowserWorkspace,
  params: BrowserPageActionParams
): Promise<BrowserNavigateResult> {
  return runHistoryAction(workspace, params, "window.history.forward()");
}

export async function browserReload(
  workspace: BrowserWorkspace,
  params: BrowserPageActionParams
): Promise<BrowserNavigateResult> {
  return runHistoryAction(workspace, params, "window.location.reload()");
}

async function requireBrowserPaneAndView(workspace: BrowserWorkspace, paneId: BrowserConnectParams["paneId"]) {
  const pane = await getBrowserPaneOrThrow(workspace, paneId);
  return { pane, view: requireBrowserViewOrThrow(pane) };
}

async function getBrowserPaneOrThrow(
  workspace: BrowserWorkspace,
  paneId: BrowserConnectParams["paneId"]
): Promise<BrowserPaneInfo> {
  const { panes } = await workspace.listBrowserPanes();
  const pane = panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) {
    throw new BrowserAutomationError("pane_not_found", `Browser pane not found: ${paneId}`);
  }

  return pane;
}

function requireBrowserViewOrThrow(pane: BrowserPaneInfo): BrowserView {
  if (pane.adapter !== "electrobun-native") {
    throw new BrowserAutomationError(
      "unsupported_adapter",
      pane.automationReason ?? `Browser pane ${pane.paneId} is not automatable`
    );
  }

  if (pane.automationStatus !== "ready" || typeof pane.webviewId !== "number") {
    throw new BrowserAutomationError("pane_not_ready", pane.automationReason ?? `Browser pane ${pane.paneId} is not ready`);
  }

  const view = BrowserView.getById(pane.webviewId);
  if (!view?.rpc?.request?.evaluateJavascriptWithResponse) {
    throw new BrowserAutomationError("pane_not_ready", `BrowserView RPC is not available for webview ${pane.webviewId}`);
  }

  return view as BrowserView;
}

async function evaluateInWebview<T>(view: BrowserView, scriptBody: string): Promise<T> {
  const rpc = view.rpc as unknown as {
    request: {
      evaluateJavascriptWithResponse: (params: { script: string }) => Promise<unknown>;
    };
  };
  const result = await rpc.request.evaluateJavascriptWithResponse({ script: scriptBody });
  return result as T;
}

async function waitForWebviewLoad(view: BrowserView, idleMs: number, includeIdle: boolean): Promise<void> {
  await pollUntil(
    async () => {
      const state = await evaluateInWebview<string>(view, "return document.readyState");
      if (state !== "complete") {
        return null;
      }
      if (includeIdle && idleMs > 0) {
        await sleep(idleMs);
      }
      return true;
    },
    "Timed out waiting for browser load"
  );
}

async function waitForTarget(view: BrowserView, target: string): Promise<void> {
  await pollUntil(
    async () =>
      (await evaluateInWebview<boolean>(view, `return !!(${buildResolveTargetExpression(target)})`)) ? true : null,
    `Timed out waiting for target: ${target}`
  );
}

async function waitForText(view: BrowserView, text: string): Promise<void> {
  await pollUntil(
    async () => ((await evaluateInWebview<string>(view, "return document.body?.innerText ?? ''")).includes(text) ? true : null),
    `Timed out waiting for text: ${text}`
  );
}

async function waitForUrl(view: BrowserView, pattern: string): Promise<void> {
  await pollUntil(
    async () => (matchUrlPattern(await evaluateInWebview<string>(view, "return window.location.href"), pattern) ? true : null),
    `Timed out waiting for URL pattern: ${pattern}`
  );
}

async function waitForFunction(view: BrowserView, expression: string): Promise<void> {
  await pollUntil(
    async () => (Boolean(await evaluateInWebview<unknown>(view, `return !!(${expression})`)) ? true : null),
    `Timed out waiting for function: ${expression}`
  );
}

async function runHistoryAction(
  workspace: BrowserWorkspace,
  params: BrowserPageActionParams,
  expression: string
): Promise<BrowserNavigateResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  pane.view.executeJavascript(expression);
  const connection = await waitForPaneReady(workspace, params.paneId, params.waitUntil ?? "load", params.idleMs ?? 500);

  return {
    ok: true,
    paneId: params.paneId,
    url: connection.url ?? ""
  };
}

async function waitForPaneReady(
  workspace: BrowserWorkspace,
  paneId: BrowserConnectParams["paneId"],
  waitUntil: "none" | "load" | "idle",
  idleMs: number,
  expectedUrl?: string
): Promise<BrowserConnectSuccess> {
  if (waitUntil === "none") {
    const connection = await tryConnect(workspace, paneId);
    if (!connection.ok) {
      throw new Error(connection.error);
    }
    return connection;
  }

  return pollUntil(
    async () => {
      const connection = await tryConnect(workspace, paneId);
      if (!connection.ok) {
        if (connection.code === "pane_not_ready") {
          return null;
        }
        throw new Error(connection.error);
      }
      if (expectedUrl && connection.url !== expectedUrl) {
        return null;
      }
      if (waitUntil === "idle" && idleMs > 0) {
        await sleep(idleMs);
      }
      return connection;
    },
    `Browser pane ${paneId} did not become ready in time`,
    200
  );
}

async function connectOrThrow(workspace: BrowserWorkspace, paneId: BrowserConnectParams["paneId"]): Promise<BrowserConnectSuccess> {
  const pane = await getBrowserPaneOrThrow(workspace, paneId);
  const view = requireBrowserViewOrThrow(pane);
  const [url, title] = await Promise.all([
    evaluateInWebview<string>(view, "return window.location.href"),
    evaluateInWebview<string>(view, "return document.title")
  ]);

  return {
    ok: true,
    paneId: pane.paneId,
    url,
    title,
    adapter: pane.adapter,
    webviewId: pane.webviewId
  };
}

async function tryConnect(
  workspace: BrowserWorkspace,
  paneId: BrowserConnectParams["paneId"]
): Promise<BrowserConnectResult> {
  try {
    return await connectOrThrow(workspace, paneId);
  } catch (error) {
    return toBrowserConnectFailure(paneId, error);
  }
}

async function pollUntil<T>(
  check: () => Promise<T | null>,
  timeoutMessage: string,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + BROWSER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(timeoutMessage);
}

function toBrowserConnectFailure(
  paneId: BrowserConnectParams["paneId"],
  error: unknown
): Extract<BrowserConnectResult, { ok: false }> {
  if (error instanceof BrowserAutomationError) {
    return {
      ok: false,
      paneId,
      code: error.code,
      error: error.message
    };
  }

  return {
    ok: false,
    paneId,
    code: "pane_not_ready",
    error: error instanceof Error ? error.message : String(error)
  };
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

function buildSnapshotScript(compact: boolean): string {
  return `
    const selectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      '[tabindex]'
    ];
    const seen = new Set();
    const lines = [];
    let counter = 0;
    document.querySelectorAll('[data-flmux-ref]').forEach((el) => el.removeAttribute('data-flmux-ref'));
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const roleOf = (el) => {
      return el.getAttribute('role')
        || (el.tagName === 'A' ? 'link' : '')
        || (el.tagName === 'BUTTON' ? 'button' : '')
        || (el.tagName === 'TEXTAREA' ? 'textbox' : '')
        || (el.tagName === 'SELECT' ? 'combobox' : '')
        || (el.tagName === 'INPUT'
          ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', text: 'textbox', email: 'textbox', search: 'searchbox', password: 'textbox' }[el.type] || 'textbox')
          : '');
    };
    for (const el of document.querySelectorAll(selectors.join(','))) {
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const role = roleOf(el);
      const name = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ');
      const value = 'value' in el && typeof el.value === 'string' ? el.value.trim() : '';
      if (${compact ? "true" : "false"} && !name && !value) continue;
      counter += 1;
      el.setAttribute('data-flmux-ref', 'e' + counter);
      let line = '@e' + counter + ' ' + (role || 'element');
      if (name) line += ' "' + name.replace(/"/g, '\\\\"') + '"';
      if (value) line += ' value="' + value.replace(/"/g, '\\\\"') + '"';
      lines.push(line);
    }
    return lines.length ? lines.join('\\n') : '(no interactive elements found)';
  `;
}

function buildResolveTargetExpression(target: string): string {
  const literal = JSON.stringify(target);
  return `(() => {
    const raw = (${literal} || '').trim();
    if (!raw) return null;
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => {
      if (!(el instanceof HTMLElement)) return '';
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ');
    };
    const implicitRole = (el) => {
      if (!(el instanceof HTMLElement)) return '';
      return el.getAttribute('role')
        || (el.tagName === 'A' ? 'link' : '')
        || (el.tagName === 'BUTTON' ? 'button' : '')
        || (el.tagName === 'TEXTAREA' ? 'textbox' : '')
        || (el.tagName === 'SELECT' ? 'combobox' : '')
        || (el.tagName === 'INPUT'
          ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', text: 'textbox', email: 'textbox', search: 'searchbox', password: 'textbox' }[el.type] || 'textbox')
          : '');
    };
    if (raw.startsWith('@')) return document.querySelector('[data-flmux-ref="' + raw.slice(1) + '"]');
    if (raw.startsWith('text=')) {
      const query = raw.slice(5).trim();
      return Array.from(document.querySelectorAll('body *')).find((el) => isVisible(el) && textOf(el).includes(query)) ?? null;
    }
    if (raw.startsWith('label=')) {
      const query = raw.slice(6).trim();
      const label = Array.from(document.querySelectorAll('label')).find((el) => textOf(el).includes(query));
      if (!label) return null;
      if ('control' in label && label.control) return label.control;
      return label.querySelector('input,textarea,select,[contenteditable="true"]');
    }
    if (raw.startsWith('role=')) {
      const spec = raw.slice(5).trim();
      const match = spec.match(/^([a-zA-Z0-9_-]+)(?:\\[name=(['"]?)(.*?)\\2\\])?$/);
      if (!match) return null;
      const role = match[1];
      const name = (match[3] || '').trim();
      return Array.from(document.querySelectorAll('body *')).find((el) => {
        if (!isVisible(el)) return false;
        if (implicitRole(el) !== role) return false;
        if (!name) return true;
        return textOf(el) === name;
      }) ?? null;
    }
    return document.querySelector(raw);
  })()`;
}

function escapeJs(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function matchUrlPattern(url: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(url);
}
