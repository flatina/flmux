type WebviewElement = HTMLElement & { _surfaceId?: number | null };

export function setupDropIndicatorMasks() {
  if (!window.bunite?.invoke) return;
  const invoke = window.bunite.invoke;

  let scheduled = false;
  let dragging = false;

  function syncMasks() {
    const dpr = window.devicePixelRatio || 1;
    const indicators = document.querySelectorAll<HTMLElement>(
      ".dv-drop-target-anchor, .dv-drop-target-selection"
    );

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

      void invoke("__bunite:surface.setMasks", { surfaceId, masks }).catch(() => {});
    }
  }

  function clearMasks() {
    for (const webview of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const surfaceId = (webview as WebviewElement)._surfaceId;
      if (surfaceId == null) continue;
      void invoke("__bunite:surface.setMasks", { surfaceId, masks: [] }).catch(() => {});
    }
  }

  function endDrag() {
    dragging = false;
    clearMasks();
  }

  document.addEventListener("dragstart", () => {
    dragging = true;
    syncMasks();
  }, true);

  document.addEventListener("dragover", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (dragging) syncMasks();
    });
  }, true);

  document.addEventListener("dragend", endDrag, true);
  document.addEventListener("drop", endDrag, true);
}
