import type { ExtensionPaneInstance } from "@flmux/extension-api";

export interface PaneCaptureEntry {
  host: HTMLElement;
  /** Undefined when the pane's `mount` returned no instance — still capturable
   *  (host rasterizes), just without the `onBeforeCapture`/`onAfterCapture` hooks. */
  instance?: ExtensionPaneInstance;
  workspaceId: string;
  kind: string;
}

const panes = new Map<string, PaneCaptureEntry>();

export function registerPaneForCapture(paneId: string, entry: PaneCaptureEntry): void {
  panes.set(paneId, entry);
}

// Element-aware: dockview recycles paneIds, so an old pane's `dispose` racing a
// new pane's `init` must not wipe the new entry.
export function unregisterPaneForCapture(paneId: string, host: HTMLElement): void {
  if (panes.get(paneId)?.host === host) panes.delete(paneId);
}

export function getPaneForCapture(paneId: string): PaneCaptureEntry | undefined {
  return panes.get(paneId);
}
