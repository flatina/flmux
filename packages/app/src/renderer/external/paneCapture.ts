import domtoimage from "dom-to-image-more";
import type { CapturePaneOptions, CapturedImage } from "@flmux/extension-api";
import { getPaneForCapture } from "./paneCaptureRegistry";

const CSS_DPI = 96;
const DEFAULT_DPI = 300;
const DEFAULT_MAX_OUTPUT_PX = 8192;
const MM_PER_INCH = 25.4;
const FALLBACK_ASPECT = 0.66; // height/width, when a hidden host reports 0 size
// Bound each hang-prone await so a stuck pane hook or rasterize (e.g. a hidden
// tab throttling dom-to-image's decode) can't wedge the exclusive lock forever.
const STEP_TIMEOUT_MS = 30_000;

// Exclusive: SciChart `DpiHelper.PIXEL_RATIO` is a global and a single offscreen
// holder is reused, so captures must not overlap. Callers await sequentially; a
// concurrent (or hook-reentrant) call rejects rather than deadlocking.
let active = false;

export async function capturePaneInWorkspace(
  callerWorkspaceId: string,
  targetPaneId: string,
  opts: CapturePaneOptions
): Promise<CapturedImage> {
  if (active) throw new Error("capturePane: a capture is already in progress — await the previous call");
  active = true;
  try {
    return await doCapture(callerWorkspaceId, targetPaneId, opts);
  } finally {
    active = false;
  }
}

function withTimeout<T>(value: Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`capturePane: ${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(value).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function doCapture(
  callerWorkspaceId: string,
  targetPaneId: string,
  opts: CapturePaneOptions
): Promise<CapturedImage> {
  const entry = getPaneForCapture(targetPaneId);
  if (!entry) throw new Error(`capturePane: pane '${targetPaneId}' is not a capturable extension pane`);
  if (entry.workspaceId !== callerWorkspaceId) {
    throw new Error(`capturePane: pane '${targetPaneId}' is in another workspace`);
  }
  const { host, instance } = entry;

  const dpi = opts.dpi ?? DEFAULT_DPI;
  const maxPx = opts.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
  if (!(opts.widthMm > 0)) throw new Error("capturePane: widthMm must be a positive number");
  if (opts.heightMm != null && !(opts.heightMm > 0)) {
    throw new Error("capturePane: heightMm must be a positive number");
  }
  if (!(dpi > 0)) throw new Error("capturePane: dpi must be a positive number");

  const layoutW = Math.max(1, Math.round((opts.widthMm / MM_PER_INCH) * CSS_DPI));
  const aspect = host.clientWidth > 0 ? host.clientHeight / host.clientWidth : FALLBACK_ASPECT;
  const layoutH = Math.max(
    1,
    Math.round(opts.heightMm != null ? (opts.heightMm / MM_PER_INCH) * CSS_DPI : layoutW * aspect)
  );
  // dpr = dpi/96 supersample, downscaled so neither output side exceeds maxPx (a
  // hard cap against the browser canvas-size limit). The clamped dpr is the
  // single source for both the pane's supersample and dom-to-image's scale.
  let dpr = dpi / CSS_DPI;
  const longest = Math.max(layoutW, layoutH) * dpr;
  if (longest > maxPx) dpr *= maxPx / longest;
  const outW = Math.round(layoutW * dpr);
  const outH = Math.round(layoutH * dpr);
  const background = opts.background ?? "white";

  const parent = host.parentElement;
  const nextSibling = host.nextSibling;
  const savedStyle = host.getAttribute("style"); // exact attribute string
  const holder = document.createElement("div");
  // display:block + off-screen → connected + laid out, so the pane's
  // ResizeObserver fires even when its dockview tab is inactive (never display:none).
  holder.style.cssText = "position:fixed;left:-99999px;top:0;display:block";

  try {
    document.body.appendChild(holder);
    holder.appendChild(host);
    host.style.width = `${layoutW}px`;
    host.style.height = `${layoutH}px`;
    // Loaded fonts before the pane bakes text into its canvas.
    if (document.fonts?.ready) await withTimeout(document.fonts.ready, STEP_TIMEOUT_MS, "fonts.ready");
    // Pane sets supersample/theme, re-fits, resolves only when settled.
    await withTimeout(
      Promise.resolve(instance?.onBeforeCapture?.({ width: outW, height: outH, dpr })),
      STEP_TIMEOUT_MS,
      "onBeforeCapture"
    );
    // width/height pin the output to the layout box so content overflow can't
    // exceed maxPx; scale supersamples → output = layout × dpr = outW/outH.
    const blob = await withTimeout(
      domtoimage.toBlob(host, { width: layoutW, height: layoutH, scale: dpr, bgcolor: background }),
      STEP_TIMEOUT_MS,
      "rasterize"
    );
    return { blob, width: outW, height: outH };
  } finally {
    // onAfterCapture is best-effort: bounded + swallowed so a stuck/throwing hook
    // can neither wedge the lock nor abort the DOM restore below.
    try {
      await withTimeout(Promise.resolve(instance?.onAfterCapture?.()), STEP_TIMEOUT_MS, "onAfterCapture");
    } catch (e) {
      console.warn(`[flmux] capturePane: onAfterCapture failed for '${targetPaneId}'`, e);
    }
    restoreHost(targetPaneId, host, parent, nextSibling, savedStyle);
    holder.remove();
  }
}

function restoreHost(
  targetPaneId: string,
  host: HTMLElement,
  parent: HTMLElement | null,
  nextSibling: Node | null,
  savedStyle: string | null
): void {
  if (savedStyle === null) host.removeAttribute("style");
  else host.setAttribute("style", savedStyle);
  // Drop the host (don't reinsert) if the pane was disposed/recycled mid-capture
  // (registry no longer maps this id to this host) or its parent is gone — the
  // owner already tore down, so reinserting would orphan or duplicate.
  if (getPaneForCapture(targetPaneId)?.host !== host || !parent || !parent.isConnected) {
    host.remove();
    return;
  }
  // nextSibling may have been removed during the capture window → append (null).
  parent.insertBefore(host, nextSibling?.parentNode === parent ? nextSibling : null);
}
