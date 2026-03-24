import { BrowserView } from "electrobun/bun";
import { sleep } from "@flatina/browser-ctl/cdp";
import type {
  BrowserActionResult,
  BrowserClickParams,
  BrowserConnectParams,
  BrowserConnectResult,
  BrowserFillParams,
  BrowserGetParams,
  BrowserGetResult,
  BrowserNavigateParams,
  BrowserNavigateResult,
  BrowserNewParams,
  BrowserPaneInfo,
  BrowserPaneResult,
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
  const pane = await getBrowserPane(workspace, params.paneId);
  if (!pane.ok) {
    return pane;
  }

  const view = requireBrowserView(pane.pane);
  if (!view.ok) {
    return view;
  }

  try {
    const [url, title] = await Promise.all([
      evaluateInWebview<string>(view.view, "return window.location.href"),
      evaluateInWebview<string>(view.view, "return document.title")
    ]);

    return {
      ok: true,
      paneId: pane.pane.paneId,
      url,
      title,
      adapter: pane.pane.adapter,
      webviewId: pane.pane.webviewId
    };
  } catch (error) {
    return {
      ok: false,
      paneId: params.paneId,
      code: "pane_not_ready",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function browserNavigate(
  workspace: BrowserWorkspace,
  params: BrowserNavigateParams
): Promise<BrowserNavigateResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const url = normalizeAutomationUrl(params.url);
  pane.view.loadURL(url);

  const waitUntil = params.waitUntil ?? "load";
  if (waitUntil !== "none") {
    await waitForWebviewLoad(pane.view, params.idleMs ?? 500, waitUntil === "idle");
  }

  return {
    ok: true,
    paneId: params.paneId,
    url: await evaluateInWebview<string>(pane.view, "return window.location.href")
  };
}

export async function browserGet(workspace: BrowserWorkspace, params: BrowserGetParams): Promise<BrowserGetResult> {
  const pane = await requireBrowserPaneAndView(workspace, params.paneId);
  const expression = params.field === "url" ? "return window.location.href" : "return document.title";
  const value = await evaluateInWebview<string>(pane.view, expression);
  return { ok: true, paneId: params.paneId, field: params.field, value };
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
  } else {
    await waitForTarget(pane.view, params.target ?? "");
  }

  return { ok: true, paneId: params.paneId };
}

async function requireBrowserPaneAndView(workspace: BrowserWorkspace, paneId: BrowserConnectParams["paneId"]) {
  const paneResult = await getBrowserPane(workspace, paneId);
  if (!paneResult.ok) {
    throw new Error(paneResult.error);
  }

  const viewResult = requireBrowserView(paneResult.pane);
  if (!viewResult.ok) {
    throw new Error(viewResult.error);
  }

  return { pane: paneResult.pane, view: viewResult.view };
}

async function getBrowserPane(
  workspace: BrowserWorkspace,
  paneId: BrowserConnectParams["paneId"]
): Promise<{ ok: true; pane: BrowserPaneInfo } | { ok: false; paneId: BrowserConnectParams["paneId"]; code: BrowserConnectResult extends infer _X ? never : never; error: string }> {
  const { panes } = await workspace.listBrowserPanes();
  const pane = panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) {
    return {
      ok: false,
      paneId,
      code: undefined as never,
      error: `Browser pane not found: ${paneId}`
    };
  }

  return { ok: true, pane };
}

function requireBrowserView(
  pane: BrowserPaneInfo
): { ok: true; view: BrowserView } | { ok: false; paneId: BrowserConnectParams["paneId"]; code: BrowserConnectResult extends infer _X ? never : never; error: string } {
  if (pane.adapter !== "electrobun-native") {
    return {
      ok: false,
      paneId: pane.paneId,
      code: undefined as never,
      error: pane.automationReason ?? `Browser pane ${pane.paneId} is not automatable`
    };
  }

  if (pane.automationStatus !== "ready" || typeof pane.webviewId !== "number") {
    return {
      ok: false,
      paneId: pane.paneId,
      code: undefined as never,
      error: pane.automationReason ?? `Browser pane ${pane.paneId} is not ready`
    };
  }

  const view = BrowserView.getById(pane.webviewId);
  if (!view?.rpc?.request?.evaluateJavascriptWithResponse) {
    return {
      ok: false,
      paneId: pane.paneId,
      code: undefined as never,
      error: `BrowserView RPC is not available for webview ${pane.webviewId}`
    };
  }

  return { ok: true, view: view as BrowserView };
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await evaluateInWebview<string>(view, "return document.readyState");
    if (state === "complete") {
      if (includeIdle && idleMs > 0) {
        await sleep(idleMs);
      }
      return;
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for browser load");
}

async function waitForTarget(view: BrowserView, target: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const exists = await evaluateInWebview<boolean>(view, `return !!(${buildResolveTargetExpression(target)})`);
    if (exists) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for target: ${target}`);
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
    if (raw.startsWith('@')) return document.querySelector('[data-flmux-ref="' + raw.slice(1) + '"]');
    return document.querySelector(raw);
  })()`;
}

function escapeJs(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
