import { ModelPathError } from "@flmux/core/shell";
import type { PaneBrowserCap } from "../../shared/rendererBridge";
import { signatureScore, SIGNATURE_MATCH_THRESHOLD, type RefRegistry } from "./refRegistry";

export type Target =
  | { type: "ref"; ref: string }
  | { type: "css"; selector: string }
  | { type: "text"; text: string }
  | { type: "label"; label: string }
  | { type: "role"; role: string; name?: string }
  | { type: "testid"; testid: string }
  | { type: "coord"; x: number; y: number };

// `@e1` | `text=` / `label=` / `testid=` / `role=name[name='X']` | `x,y` | CSS
export function parseTarget(input: string): Target {
  const s = input.trim();
  if (s.startsWith("@")) return { type: "ref", ref: s };
  if (s.startsWith("text=")) return { type: "text", text: s.slice(5) };
  if (s.startsWith("label=")) return { type: "label", label: s.slice(6) };
  if (s.startsWith("testid=")) return { type: "testid", testid: s.slice(7) };
  if (s.startsWith("role=")) {
    const body = s.slice(5);
    const m = body.match(/^([\w-]+)(?:\[name=['"](.+)['"]\])?$/);
    if (!m) throw new ModelPathError("INVALID_VALUE", `bad role= target: ${input}`);
    return { type: "role", role: m[1], name: m[2] };
  }
  const coord = s.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (coord) return { type: "coord", x: Number(coord[1]), y: Number(coord[2]) };
  return { type: "css", selector: s };
}

export interface ResolvedTarget {
  selector: string;
  frameId?: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

// "" return = caller should run findElementScript via evaluate
export function selectorForTarget(t: Exclude<Target, { type: "ref" } | { type: "coord" }>): string {
  switch (t.type) {
    case "css":
      return t.selector;
    case "testid":
      return `[data-testid=${JSON.stringify(t.testid)}]`;
    case "text":
    case "label":
    case "role":
      return "";
  }
}

export function findElementScript(t: Exclude<Target, { type: "ref" } | { type: "coord" } | { type: "css" }>): string {
  const payload = JSON.stringify(t);
  return `(() => {
    const t = ${payload};
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const eq = (a, b) => norm(a) === norm(b);
    const contains = (haystack, needle) => norm(haystack).includes(norm(needle));
    const accessibleName = (n) => norm(n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "");
    let el = null;
    if (t.type === "testid") {
      el = document.querySelector('[data-testid=' + JSON.stringify(t.testid) + ']');
    } else if (t.type === "text") {
      const candidates = document.querySelectorAll("button, a, [role='button'], [role='link'], summary, [role='menuitem']");
      el = [...candidates].find(n => eq(n.textContent, t.text))
        || [...candidates].find(n => contains(n.textContent, t.text))
        || null;
    } else if (t.type === "label") {
      const lbl = [...document.querySelectorAll("label")].find(l => eq(l.textContent, t.label))
        || [...document.querySelectorAll("label")].find(l => contains(l.textContent, t.label));
      const forId = lbl?.getAttribute("for");
      el = forId ? document.getElementById(forId) : (lbl?.querySelector("input, textarea, select") || null);
    } else if (t.type === "role") {
      const explicit = [...document.querySelectorAll('[role=' + JSON.stringify(t.role) + ']')];
      const implicit = t.role === "button" ? [...document.querySelectorAll("button")]
        : t.role === "link" ? [...document.querySelectorAll("a[href]")]
        : t.role === "textbox" ? [...document.querySelectorAll("input:not([type=button]):not([type=submit]), textarea")]
        : [];
      const all = [...explicit, ...implicit];
      el = !t.name ? (all[0] || null)
        : all.find(n => eq(accessibleName(n), t.name))
          || all.find(n => contains(accessibleName(n), t.name))
          || null;
    }
    if (!el) return null;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      const idx = Array.from(cur.parentElement?.children ?? []).indexOf(cur) + 1;
      parts.unshift(tag + ':nth-child(' + idx + ')');
      cur = cur.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  })()`;
}

export async function resolveTarget(
  cap: PaneBrowserCap,
  paneId: string,
  registry: RefRegistry,
  navigationEpoch: number,
  target: Target
): Promise<ResolvedTarget | { type: "coord"; x: number; y: number }> {
  if (target.type === "coord") return { type: "coord", x: target.x, y: target.y };

  if (target.type === "ref") {
    const entry = registry.get(target.ref);
    if (!entry) throw new ModelPathError("INVALID_VALUE", `unknown ref ${target.ref}`);
    if (entry.generation !== registry.currentGeneration) {
      throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (regeneration; re-snapshot)`);
    }
    if (navigationEpoch > entry.snapshotEpoch) {
      throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (navigation; re-snapshot)`);
    }
    const rect = await cap.getBoundingRect({ paneId, selector: entry.selector, frameId: entry.frameId });
    if (!rect.ok) {
      throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (${rect.code}: ${rect.message})`);
    }
    const liveSig = await readSignature(cap, paneId, entry.selector, entry.frameId);
    if (!liveSig) {
      throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (signature unreadable)`);
    }
    if (signatureScore(entry.signature, liveSig) < SIGNATURE_MATCH_THRESHOLD) {
      throw new ModelPathError("INVALID_VALUE", `stale_ref: ${target.ref} (signature mismatch)`);
    }
    return { selector: entry.selector, frameId: entry.frameId, rect: rect.rect, visible: rect.visible };
  }

  let selector: string;
  if (target.type === "css") {
    selector = target.selector;
  } else {
    const script = findElementScript(target);
    const result = await cap.evaluate({ paneId, script });
    if (!result.ok) {
      throw new ModelPathError("INVALID_VALUE", `target resolve failed: ${result.code}: ${result.message}`);
    }
    if (typeof result.value !== "string" || result.value.length === 0) {
      throw new ModelPathError("INVALID_VALUE", `target not found: ${JSON.stringify(target)}`);
    }
    selector = result.value;
  }

  const rect = await cap.getBoundingRect({ paneId, selector });
  if (!rect.ok) {
    throw new ModelPathError("INVALID_VALUE", `target not found: ${rect.code}: ${rect.message}`);
  }
  return { selector, rect: rect.rect, visible: rect.visible };
}

async function readSignature(
  cap: PaneBrowserCap,
  paneId: string,
  selector: string,
  frameId?: string
): Promise<import("./refRegistry").RefSignature | null> {
  const payload = JSON.stringify(selector);
  const script = `(() => {
    const el = document.querySelector(${payload});
    if (!el) return null;
    const txt = (el.textContent || '').slice(0, 200);
    let h = 0;
    for (let i = 0; i < txt.length; i++) { h = ((h << 5) - h + txt.charCodeAt(i)) | 0; }
    const textHash = (h >>> 0).toString(16).slice(0, 8);
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.parentElement && depth < 6) {
      const idx = Array.from(cur.parentElement.children).indexOf(cur);
      parts.unshift(idx);
      cur = cur.parentElement; depth++;
    }
    let ancestorIdHint;
    cur = el;
    while (cur && cur !== document.body) {
      const id = cur.getAttribute('data-testid') || cur.getAttribute('data-id') ||
                 cur.getAttribute('aria-rowindex') || cur.getAttribute('data-key') || cur.id;
      if (id) { ancestorIdHint = id; break; }
      cur = cur.parentElement;
    }
    return {
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 100)) || '',
      type: el.getAttribute('type') || undefined,
      id: el.id || undefined,
      textHash,
      domOrderKey: parts.join('.'),
      ancestorIdHint
    };
  })()`;
  const result = await cap.evaluate({ paneId, script, frameId });
  if (!result.ok || typeof result.value !== "object" || result.value == null) return null;
  return result.value as import("./refRegistry").RefSignature;
}
