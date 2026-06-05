import { ModelPathError } from "@flmux/core/shell";
import type { PaneBrowserCap, BrowserPaneSurfaceEvent } from "../../shared/rendererBridge";
import type { PaneState } from "./paneState";
import { parseTarget, resolveTarget, type Target } from "./targetResolver";
import type { RefRegistrationInput, RefSignature } from "./refRegistry";

const DEFAULT_WAIT_MS = 30_000;

// ---------- helpers ----------

function expectString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ModelPathError("INVALID_VALUE", `arg '${key}' must be string`);
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ModelPathError("INVALID_VALUE", `arg '${key}' must be string`);
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ModelPathError("INVALID_VALUE", `arg '${key}' must be finite number`);
  }
  return v;
}

function targetOf(args: Record<string, unknown>): Target {
  return parseTarget(expectString(args, "target"));
}

function center(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function evalOk<T = unknown>(cap: PaneBrowserCap, paneId: string, script: string, frameId?: string): Promise<T> {
  const r = await cap.evaluate({ paneId, script, frameId });
  if (!r.ok) throw new ModelPathError("INVALID_VALUE", `evaluate: ${r.code}: ${r.message}`);
  return r.value as T;
}

// ---------- snapshot ----------

const SNAPSHOT_SCRIPT = `(() => {
  const refs = [];
  let counter = 0;
  const INTERACTIVE = new Set(["BUTTON","A","INPUT","SELECT","TEXTAREA","SUMMARY","LABEL"]);
  const ROLES = new Set(["button","link","textbox","searchbox","combobox","listbox","checkbox","radio","tab","menuitem","switch","slider"]);
  function isInteractive(el) {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
    if (INTERACTIVE.has(el.tagName)) return true;
    const role = el.getAttribute("role");
    if (role && ROLES.has(role)) return true;
    if (el.tagName === "DIV" && el.getAttribute("tabindex") !== null) return true;
    return false;
  }
  function selectorOf(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.parentElement && cur !== document.body && parts.length < 8) {
      const tag = cur.tagName.toLowerCase();
      const idx = Array.from(cur.parentElement.children).indexOf(cur) + 1;
      parts.unshift(tag + ":nth-child(" + idx + ")");
      cur = cur.parentElement;
    }
    return parts.length ? ("body > " + parts.join(" > ")) : el.tagName.toLowerCase();
  }
  function textHash(s) {
    s = (s || "").slice(0, 200);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).slice(0, 8);
  }
  function ancestorIdHint(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const id = cur.getAttribute("data-testid") || cur.getAttribute("data-id") ||
                 cur.getAttribute("aria-rowindex") || cur.getAttribute("data-key") || cur.id;
      if (id) return id;
      cur = cur.parentElement;
    }
    return undefined;
  }
  function domOrderKey(el) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.parentElement && depth < 6) {
      parts.unshift(Array.from(cur.parentElement.children).indexOf(cur));
      cur = cur.parentElement; depth++;
    }
    return parts.join(".");
  }
  for (const el of document.querySelectorAll("*")) {
    if (!isInteractive(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    counter++;
    const ref = "@e" + counter;
    const name = (el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 100)) || "";
    refs.push({
      ref,
      selector: selectorOf(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      signature: {
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name,
        type: el.getAttribute("type") || undefined,
        id: el.id || undefined,
        textHash: textHash(el.textContent || ""),
        domOrderKey: domOrderKey(el),
        ancestorIdHint: ancestorIdHint(el)
      }
    });
  }
  return refs;
})()`;

interface SnapshotRefRaw {
  ref: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  signature: RefSignature;
}

export async function snapshot(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  _args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const nav = await cap.getNavigationState({ paneId });
  const raw = await evalOk<SnapshotRefRaw[]>(cap, paneId, SNAPSHOT_SCRIPT);
  const epoch = state.refRegistry.beginSnapshot();
  const entries: RefRegistrationInput[] = raw.map((r) => ({
    ref: r.ref,
    snapshotEpoch: nav.lastLoadEpoch,
    selector: r.selector,
    rect: r.rect,
    signature: r.signature
  }));
  state.refRegistry.register(entries);
  // Drop heavy fields from output — agent typically wants ref + role + name.
  const compact = raw.map((r) => ({
    ref: r.ref,
    role: r.signature.role,
    name: r.signature.name,
    type: r.signature.type,
    rect: r.rect
  }));
  return { value: { generation: epoch, refs: compact, url: nav.currentUrl } };
}

// ---------- find ----------

export async function find(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const by = expectString(args, "by");
  const value = expectString(args, "value");
  const targetString =
    by === "role"
      ? `role=${value}`
      : by === "text" || by === "label" || by === "testid"
        ? `${by}=${value}`
        : (() => {
            throw new ModelPathError("INVALID_VALUE", `unsupported find by='${by}'`);
          })();
  const target = parseTarget(targetString);
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target);
  if ("type" in resolved && resolved.type === "coord") {
    throw new ModelPathError("INTERNAL_ERROR", "find returned coord");
  }
  return { value: resolved };
}

// ---------- click / dblclick / hover / focus ----------

async function resolveCoord(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  target: Target
): Promise<{ x: number; y: number; selector?: string; frameId?: string }> {
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target);
  if ("type" in resolved && resolved.type === "coord") return { x: resolved.x, y: resolved.y };
  const c = center((resolved as { rect: { x: number; y: number; width: number; height: number } }).rect);
  return {
    x: c.x,
    y: c.y,
    selector: (resolved as { selector?: string }).selector,
    frameId: (resolved as { frameId?: string }).frameId
  };
}

function rejectFrameInput(resolved: { frameId?: string }) {
  if (resolved.frameId) {
    throw new ModelPathError("NOT_SUPPORTED", "frame-targeted input dispatch deferred to bunite v11");
  }
}

export async function click(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  if (typeof args.target !== "string" && typeof args.x === "number" && typeof args.y === "number") {
    await cap.click({
      paneId,
      x: args.x,
      y: args.y,
      button: optionalButton(args.button),
      clickCount: optionalNumber(args, "clickCount"),
      modifiers: optionalModifierArr(args.modifiers)
    });
    return { value: null };
  }
  const target = targetOf(args);
  // CSS/ref → atomic resolveAndClick (race-free + OOPIF cover for refs in
  // cross-origin iframes, bunite 0.16.0+). Ref signature gate skipped — the
  // atomic call's selector miss returns `not_found`, surfacing clearly.
  // text=/role=/label= still need page-side composition → fallback path.
  const caps = await state.getCapabilities();
  if (caps.resolveAndClick && (target.type === "css" || target.type === "ref")) {
    let selector: string;
    let frameId: string | undefined;
    if (target.type === "css") {
      selector = target.selector;
    } else {
      const entry = state.refRegistry.get(target.ref);
      if (!entry) throw new ModelPathError("INVALID_VALUE", `unknown ref ${target.ref}`);
      if (entry.generation !== state.refRegistry.currentGeneration) {
        throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (re-snapshot)`);
      }
      selector = entry.selector;
      frameId = entry.frameId;
    }
    const result = await cap.resolveAndClick({
      paneId,
      selector,
      frameId,
      button: optionalButton(args.button),
      clickCount: optionalNumber(args, "clickCount"),
      modifiers: optionalModifierArr(args.modifiers)
    });
    if (!result.ok) {
      throw new ModelPathError("INVALID_VALUE", `click: ${result.code}: ${result.message}`);
    }
    return { value: { rect: result.rect, isTrustedEvent: result.isTrustedEvent } };
  }
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  await cap.click({
    paneId,
    x: resolved.x,
    y: resolved.y,
    button: optionalButton(args.button),
    clickCount: optionalNumber(args, "clickCount"),
    modifiers: optionalModifierArr(args.modifiers)
  });
  return { value: null };
}

function optionalButton(v: unknown): "left" | "middle" | "right" | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "left" || v === "middle" || v === "right") return v;
  throw new ModelPathError("INVALID_VALUE", `button must be left|middle|right`);
}

const MODIFIER_NAMES = new Set(["alt", "ctrl", "meta", "shift"]);

function optionalModifierArr(v: unknown): Array<"alt" | "ctrl" | "meta" | "shift"> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ModelPathError("INVALID_VALUE", `modifiers must be array`);
  const out: Array<"alt" | "ctrl" | "meta" | "shift"> = [];
  for (const m of v) {
    if (typeof m !== "string" || !MODIFIER_NAMES.has(m)) {
      throw new ModelPathError("INVALID_VALUE", `modifier must be one of alt|ctrl|meta|shift`);
    }
    out.push(m as "alt" | "ctrl" | "meta" | "shift");
  }
  return out;
}

export async function dblclick(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  await cap.click({ paneId, x: resolved.x, y: resolved.y, clickCount: 2 });
  return { value: null };
}

export async function hover(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  await cap.mouse({ paneId, action: "move", x: resolved.x, y: resolved.y });
  return { value: null };
}

export async function focus(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const resolved = await resolveCoord(cap, paneId, state, target);
  // DOM `.focus()` is frame-safe via `evaluate({frameId})`; coord fallback for
  // bare coord targets calls native click which doesn't support frameId.
  if (resolved.selector) {
    const script = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (el && typeof el.focus === "function") { el.focus(); return true; } return false; })()`;
    await evalOk(cap, paneId, script, resolved.frameId);
  } else {
    rejectFrameInput(resolved);
    await cap.click({ paneId, x: resolved.x, y: resolved.y });
  }
  return { value: null };
}

// ---------- fill / type-extra ----------

export async function fill(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const text = optionalString(args, "text") ?? "";
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  // Focus + select-all + delete + (type if text non-empty)
  await cap.click({ paneId, x: resolved.x, y: resolved.y });
  await cap.press({ paneId, key: "a", modifiers: ["ctrl"] });
  await cap.press({ paneId, key: "Delete" });
  if (text.length > 0) await cap.type({ paneId, text });
  return { value: null };
}

// ---------- scroll / scrollTo ----------

export async function scrollTo(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target);
  if ("type" in resolved && resolved.type === "coord") {
    throw new ModelPathError("INVALID_VALUE", "scrollTo requires non-coord target");
  }
  const selector = (resolved as { selector: string }).selector;
  const frameId = (resolved as { frameId?: string }).frameId;
  const script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({behavior:"instant", block:"center"}); return !!el; })()`;
  await evalOk(cap, paneId, script, frameId);
  return { value: null };
}

// ---------- get.* ----------

export async function getText(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) => `(document.querySelector(${sel})?.innerText) ?? null`
    )
  };
}

export async function getHtml(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) => `(document.querySelector(${sel})?.outerHTML) ?? null`
    )
  };
}

export async function getValue(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) => `(() => { const el = document.querySelector(${sel}); return el ? (el.value ?? null) : null; })()`
    )
  };
}

export async function getAttr(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const name = expectString(args, "name");
  const nameLit = JSON.stringify(name);
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) =>
        `(() => { const el = document.querySelector(${sel}); return el ? el.getAttribute(${nameLit}) : null; })()`
    )
  };
}

export async function getBox(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target);
  if ("type" in resolved && resolved.type === "coord") {
    return { value: { x: resolved.x, y: resolved.y, width: 0, height: 0, visible: true } };
  }
  return { value: { ...(resolved as { rect: object }).rect, visible: (resolved as { visible: boolean }).visible } };
}

export async function getCount(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const selector = await selectorOfTarget(cap, paneId, state, targetOf(args));
  const r = await evalOk<number>(cap, paneId, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
  return { value: r };
}

export async function getUrl(
  cap: PaneBrowserCap,
  paneId: string,
  _state: PaneState,
  _args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const nav = await cap.getNavigationState({ paneId });
  return { value: nav.currentUrl };
}

export async function getTitle(
  cap: PaneBrowserCap,
  paneId: string,
  _state: PaneState,
  _args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return { value: await evalOk<string>(cap, paneId, "document.title") };
}

// ---------- is.* ----------

export async function isVisible(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target).catch(() => null);
  if (!resolved || ("type" in resolved && resolved.type === "coord")) return { value: false };
  return { value: (resolved as { visible: boolean }).visible };
}

export async function isEnabled(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) =>
        `(() => { const el = document.querySelector(${sel}); return el ? !el.matches('[disabled], [aria-disabled="true"]') : false; })()`
    )
  };
}

export async function isChecked(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return {
    value: await readWithTarget(
      cap,
      paneId,
      state,
      args,
      (sel) =>
        `(() => { const el = document.querySelector(${sel}); if (!el) return false; if ('checked' in el) return !!el.checked; return el.getAttribute('aria-checked') === 'true'; })()`
    )
  };
}

// ---------- wait.* ----------

export async function wait(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const variant = expectString(args, "variant");
  const timeoutMs = optionalNumber(args, "timeoutMs") ?? DEFAULT_WAIT_MS;
  const arg = optionalString(args, "arg");

  if (variant === "selector") {
    if (!arg) throw new ModelPathError("INVALID_VALUE", "wait selector requires 'arg'");
    const r = await cap.waitForSelector({ paneId, selector: arg, timeoutMs });
    if (!r.ok) throw new ModelPathError("INVALID_VALUE", `wait selector: ${r.code}: ${r.message}`);
    return { value: { matched: arg } };
  }
  if (variant === "fn") {
    if (!arg) throw new ModelPathError("INVALID_VALUE", "wait fn requires 'arg'");
    const r = await cap.waitForFunction({ paneId, expression: arg, timeoutMs });
    if (!r.ok) throw new ModelPathError("INVALID_VALUE", `wait fn: ${r.code}: ${r.message}`);
    return { value: { matched: arg } };
  }
  if (variant === "text") {
    if (!arg) throw new ModelPathError("INVALID_VALUE", "wait text requires 'arg'");
    const expression = `document.body && document.body.innerText.indexOf(${JSON.stringify(arg)}) >= 0`;
    const r = await cap.waitForFunction({ paneId, expression, timeoutMs });
    if (!r.ok) throw new ModelPathError("INVALID_VALUE", `wait text: ${r.code}: ${r.message}`);
    return { value: { matched: arg } };
  }
  if (variant === "load" || variant === "url" || variant === "navigate") {
    const nav = await cap.getNavigationState({ paneId });
    const beforeEpoch = nav.lastLoadEpoch;
    const urlGlob = variant === "url" ? (arg ?? null) : null;
    // Pre-check: if `wait url` is called with the page already on the target
    // URL and not currently loading, satisfy immediately. Equivalent guard
    // for `wait load` would block forever otherwise — caller usually pairs it
    // with a click trigger, so we don't pre-resolve there.
    if (variant === "url" && urlGlob && !nav.isLoading && globMatch(nav.currentUrl, urlGlob)) {
      return { value: { matched: true, url: nav.currentUrl } };
    }
    const wanted: BrowserPaneSurfaceEvent["type"][] =
      variant === "navigate" ? ["navigate"] : variant === "load" ? ["load-finish"] : ["navigate", "load-finish"];
    return await new Promise((resolve, reject) => {
      const id = `wait_${Date.now()}_${Math.random()}`;
      const off = state.surfaceEventBus.on((e) => {
        if (!wanted.includes(e.type)) return;
        if (e.epoch <= beforeEpoch) return;
        if (urlGlob && e.type !== "title-change" && "url" in e) {
          if (!globMatch(e.url, urlGlob)) return;
        }
        cleanup();
        resolve({ value: { matched: true, url: "url" in e ? e.url : undefined } });
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new ModelPathError("INVALID_VALUE", `wait ${variant}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        off();
        clearTimeout(timer);
        state.pendingWaiters.delete(id);
      };
      state.pendingWaiters.set(id, {
        cancel: (reason) => {
          cleanup();
          reject(new ModelPathError("INVALID_VALUE", `wait cancelled: ${reason}`));
        }
      });
    });
  }
  if (variant === "idle") {
    // Heuristic: wait for load-finish, then 500ms quiet via performance entries.
    const nav = await cap.getNavigationState({ paneId });
    if (nav.isLoading) {
      await wait(cap, paneId, state, { variant: "load", timeoutMs });
    }
    const expression = `(() => { const e = performance.getEntriesByType("resource"); const now = performance.now(); return !e.some(r => now - (r.startTime + r.duration) < 500); })()`;
    const r = await cap.waitForFunction({ paneId, expression, timeoutMs, pollIntervalMs: 100 });
    if (!r.ok) throw new ModelPathError("INVALID_VALUE", `wait idle: ${r.code}: ${r.message}`);
    return { value: { matched: true } };
  }
  throw new ModelPathError("INVALID_VALUE", `unknown wait variant '${variant}'`);
}

// ---------- internals ----------

async function selectorOfTarget(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  target: Target
): Promise<string> {
  if (target.type === "css") return target.selector;
  const nav = await cap.getNavigationState({ paneId });
  const resolved = await resolveTarget(cap, paneId, state.refRegistry, nav.lastLoadEpoch, target);
  if ("type" in resolved && resolved.type === "coord") {
    throw new ModelPathError("INVALID_VALUE", "operation requires non-coord target");
  }
  return (resolved as { selector: string }).selector;
}

async function readWithTarget(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>,
  build: (selectorLiteral: string) => string
): Promise<unknown> {
  const target = targetOf(args);
  const selector = await selectorOfTarget(cap, paneId, state, target);
  return await evalOk(cap, paneId, build(JSON.stringify(selector)));
}

function globMatch(s: string, glob: string): boolean {
  // Minimal `**` + `*` glob. Anchored to full match.
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLE::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLE::/g, ".*") +
      "$"
  );
  return re.test(s);
}

// ---------- check / uncheck / select ----------

async function getCheckedState(cap: PaneBrowserCap, paneId: string, selector: string): Promise<boolean> {
  const script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; if ('checked' in el) return !!el.checked; return el.getAttribute('aria-checked') === 'true'; })()`;
  return Boolean(await evalOk<boolean | null>(cap, paneId, script));
}

export async function check(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  if (!resolved.selector) {
    throw new ModelPathError("INVALID_VALUE", "check requires resolvable selector");
  }
  if (!(await getCheckedState(cap, paneId, resolved.selector))) {
    await cap.click({ paneId, x: resolved.x, y: resolved.y });
  }
  return { value: null };
}

export async function uncheck(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const resolved = await resolveCoord(cap, paneId, state, target);
  rejectFrameInput(resolved);
  if (!resolved.selector) {
    throw new ModelPathError("INVALID_VALUE", "uncheck requires resolvable selector");
  }
  if (await getCheckedState(cap, paneId, resolved.selector)) {
    await cap.click({ paneId, x: resolved.x, y: resolved.y });
  }
  return { value: null };
}

export async function select(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const value = expectString(args, "value");
  const selector = await selectorOfTarget(cap, paneId, state, target);
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.tagName !== "SELECT") return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
  const ok = await evalOk<boolean>(cap, paneId, script);
  if (!ok) throw new ModelPathError("INVALID_VALUE", "select: element not found or not a <select>");
  return { value: null };
}

// ---------- highlight ----------

export async function highlight(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const target = targetOf(args);
  const durationMs = optionalNumber(args, "durationMs") ?? 1500;
  const selector = await selectorOfTarget(cap, paneId, state, target);
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = document.createElement("div");
    o.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff4081;background:rgba(255,64,129,0.15);box-sizing:border-box;left:" + r.x + "px;top:" + r.y + "px;width:" + r.width + "px;height:" + r.height + "px";
    document.body.appendChild(o);
    setTimeout(() => o.remove(), ${durationMs});
    return true;
  })()`;
  await evalOk(cap, paneId, script);
  return { value: null };
}

// ---------- dialog ----------

export async function dialogAccept(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const d = state.pendingDialog;
  if (!d) throw new ModelPathError("INVALID_VALUE", "dialog accept: no pending dialog");
  const promptText = optionalString(args, "promptText");
  await cap.respondToDialog({ paneId, requestId: d.requestId, accept: true, promptText });
  state.pendingDialog = null;
  return { value: { kind: d.kind } };
}

export async function dialogDismiss(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  _args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const d = state.pendingDialog;
  if (!d) throw new ModelPathError("INVALID_VALUE", "dialog dismiss: no pending dialog");
  await cap.respondToDialog({ paneId, requestId: d.requestId, accept: false });
  state.pendingDialog = null;
  return { value: { kind: d.kind } };
}

// ---------- console / errors ----------

export async function consoleList(
  cap: PaneBrowserCap,
  paneId: string,
  _state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  const clear = args.clear === true;
  const level = optionalString(args, "level");
  let entries = await cap.getConsoleBuffer({ paneId, clear });
  if (level && level !== "all") entries = entries.filter((e) => e.level === level);
  return { value: entries };
}

export async function errorsList(
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  return await consoleList(cap, paneId, state, { ...args, level: "error" });
}

// ---------- dispatcher ----------

export const AGENT_OPS = new Set<string>([
  "snapshot",
  "find",
  "click",
  "dblclick",
  "hover",
  "focus",
  "fill",
  "scrollTo",
  "check",
  "uncheck",
  "select",
  "highlight",
  "dialogAccept",
  "dialogDismiss",
  "consoleList",
  "errorsList",
  "getText",
  "getHtml",
  "getValue",
  "getAttr",
  "getBox",
  "getCount",
  "getUrl",
  "getTitle",
  "isVisible",
  "isEnabled",
  "isChecked",
  "wait"
]);

export async function dispatchAgentOp(
  op: string,
  cap: PaneBrowserCap,
  paneId: string,
  state: PaneState,
  args: Record<string, unknown>
): Promise<{ value: unknown }> {
  switch (op) {
    case "snapshot":
      return snapshot(cap, paneId, state, args);
    case "find":
      return find(cap, paneId, state, args);
    case "click":
      return click(cap, paneId, state, args);
    case "dblclick":
      return dblclick(cap, paneId, state, args);
    case "hover":
      return hover(cap, paneId, state, args);
    case "focus":
      return focus(cap, paneId, state, args);
    case "fill":
      return fill(cap, paneId, state, args);
    case "scrollTo":
      return scrollTo(cap, paneId, state, args);
    case "getText":
      return getText(cap, paneId, state, args);
    case "getHtml":
      return getHtml(cap, paneId, state, args);
    case "getValue":
      return getValue(cap, paneId, state, args);
    case "getAttr":
      return getAttr(cap, paneId, state, args);
    case "getBox":
      return getBox(cap, paneId, state, args);
    case "getCount":
      return getCount(cap, paneId, state, args);
    case "getUrl":
      return getUrl(cap, paneId, state, args);
    case "getTitle":
      return getTitle(cap, paneId, state, args);
    case "isVisible":
      return isVisible(cap, paneId, state, args);
    case "isEnabled":
      return isEnabled(cap, paneId, state, args);
    case "isChecked":
      return isChecked(cap, paneId, state, args);
    case "wait":
      return wait(cap, paneId, state, args);
    case "check":
      return check(cap, paneId, state, args);
    case "uncheck":
      return uncheck(cap, paneId, state, args);
    case "select":
      return select(cap, paneId, state, args);
    case "highlight":
      return highlight(cap, paneId, state, args);
    case "dialogAccept":
      return dialogAccept(cap, paneId, state, args);
    case "dialogDismiss":
      return dialogDismiss(cap, paneId, state, args);
    case "consoleList":
      return consoleList(cap, paneId, state, args);
    case "errorsList":
      return errorsList(cap, paneId, state, args);
    default:
      throw new ModelPathError("INVALID_VALUE", `unknown agent op '${op}'`);
  }
}
