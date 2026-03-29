import type { DockviewApi } from "dockview-core";
import type { HostRpc } from "../rpc/host-rpc";

export function attachWorkspaceResizeObserver(
  dockview: DockviewApi | null,
  host: HTMLElement
): ResizeObserver | null {
  if (!dockview) {
    return null;
  }

  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) {
      return;
    }

    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) {
      dockview.layout(width, height, true);
    }
  });

  observer.observe(host);

  const rect = host.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    dockview.layout(rect.width, rect.height, true);
  }

  return observer;
}

export function installWindowResizeHandles(hostRpc: HostRpc): (() => void) | null {
  const runtime = window as Window & { __electrobun?: unknown; __electrobunWindowId?: unknown };
  const isElectrobun =
    typeof runtime.__electrobun !== "undefined" || typeof runtime.__electrobunWindowId === "number";
  if (!isElectrobun) {
    return null;
  }

  const handles: HTMLDivElement[] = [];
  const cleanupCallbacks: Array<() => void> = [];
  const edges = ["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const;

  for (const edge of edges) {
    const el = document.createElement("div");
    el.className = `resize-handle resize-${edge}`;
    document.body.appendChild(el);
    handles.push(el);

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      el.setPointerCapture(event.pointerId);

      const startX = event.screenX;
      const startY = event.screenY;

      void hostRpc.request("window.frame.get", undefined).then((initial) => {
        let rafId = 0;
        let latestX = startX;
        let latestY = startY;

        const applyResize = (): void => {
          rafId = 0;
          const dx = latestX - startX;
          const dy = latestY - startY;
          let x = initial.x;
          let y = initial.y;
          let width = initial.width;
          let height = initial.height;

          if (edge.includes("e")) width += dx;
          if (edge.includes("w")) {
            x += dx;
            width -= dx;
          }
          if (edge.includes("s")) height += dy;
          if (edge.includes("n")) {
            y += dy;
            height -= dy;
          }

          if (width < 400) {
            if (edge.includes("w")) x = initial.x + initial.width - 400;
            width = 400;
          }
          if (height < 300) {
            if (edge.includes("n")) y = initial.y + initial.height - 300;
            height = 300;
          }

          void hostRpc.request("window.frame.set", { x, y, width, height, maximized: false });
        };

        const onMove = (moveEvent: PointerEvent): void => {
          latestX = moveEvent.screenX;
          latestY = moveEvent.screenY;
          if (!rafId) rafId = requestAnimationFrame(applyResize);
        };

        const onUp = (): void => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("lostpointercapture", onUp);
          if (rafId) {
            cancelAnimationFrame(rafId);
            applyResize();
          }
        };

        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("lostpointercapture", onUp);
      });
    };

    el.addEventListener("pointerdown", onPointerDown);
    cleanupCallbacks.push(() => el.removeEventListener("pointerdown", onPointerDown));
  }

  return () => {
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
    for (const handle of handles) {
      handle.remove();
    }
  };
}
