import { getConnection } from "bunite-core/rpc/renderer";

type WebviewElement = HTMLElement & { _surfaceId?: number | null };

export function setupDropIndicatorMasks() {
  let surfaceCapPromise: ReturnType<typeof loadSurfaceCap> | null = null;
  let scheduled = false;
  let dragging = false;

  async function loadSurfaceCap() {
    try {
      const conn = await getConnection();
      const runtime = conn.runtime();
      return await runtime.surface();
    } catch (error) {
      console.warn("[flmux] surface cap unavailable; drop-indicator masks disabled", error);
      return null;
    }
  }

  function ensureSurface() {
    if (!surfaceCapPromise) surfaceCapPromise = loadSurfaceCap();
    return surfaceCapPromise;
  }

  async function syncMasks() {
    const surface = await ensureSurface();
    if (!surface) return;
    const dpr = window.devicePixelRatio || 1;
    const indicators = document.querySelectorAll<HTMLElement>(".dv-drop-target-anchor, .dv-drop-target-selection");

    for (const webview of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const webviewRect = webview.getBoundingClientRect();
      if (webviewRect.width === 0 || webviewRect.height === 0) continue;

      const surfaceId = (webview as WebviewElement)._surfaceId;
      if (surfaceId == null) continue;

      const masks: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const indicator of indicators) {
        const indicatorRect = indicator.getBoundingClientRect();
        if (indicatorRect.width === 0 || indicatorRect.height === 0) continue;

        const left = Math.max(webviewRect.left, indicatorRect.left);
        const top = Math.max(webviewRect.top, indicatorRect.top);
        const right = Math.min(webviewRect.right, indicatorRect.right);
        const bottom = Math.min(webviewRect.bottom, indicatorRect.bottom);
        if (left >= right || top >= bottom) continue;

        masks.push({
          x: Math.round(left * dpr),
          y: Math.round(top * dpr),
          w: Math.round((right - left) * dpr),
          h: Math.round((bottom - top) * dpr)
        });
      }

      void surface.setMasks({ surfaceId, masks }).catch(() => {});
    }
  }

  async function clearMasks() {
    const surface = await ensureSurface();
    if (!surface) return;
    for (const webview of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const surfaceId = (webview as WebviewElement)._surfaceId;
      if (surfaceId == null) continue;
      void surface.setMasks({ surfaceId, masks: [] }).catch(() => {});
    }
  }

  function endDrag() {
    dragging = false;
    void clearMasks();
  }

  document.addEventListener(
    "dragstart",
    () => {
      dragging = true;
      void syncMasks();
    },
    true
  );

  document.addEventListener(
    "dragover",
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (dragging) void syncMasks();
      });
    },
    true
  );

  document.addEventListener("dragend", endDrag, true);
  document.addEventListener("drop", endDrag, true);
}
