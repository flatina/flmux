import type { DockviewApi } from "dockview-core";
import { createFlmuxLastFile, type FlmuxLastFile, type WindowFrame } from "../model/flmux-last";
import { sanitizeSerializedLayout } from "./helpers";
import { focusWorkspacePane, getWorkspaceActivePaneId } from "./workspace-layout";
import type { TabRenderer } from "./tabs/tab-renderer";

export function captureWorkspaceFile(
  dockview: DockviewApi,
  tabRenderers: Map<string, TabRenderer>,
  windowFrame?: WindowFrame
): FlmuxLastFile {
  for (const renderer of tabRenderers.values()) {
    renderer.flushInnerLayout();
  }

  return createFlmuxLastFile({
    activePaneId: getWorkspaceActivePaneId(dockview, tabRenderers),
    workspaceLayout: sanitizeSerializedLayout(dockview.toJSON()).layout,
    window: windowFrame
  });
}

export function restoreWorkspaceFile(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  file: Pick<FlmuxLastFile, "workspaceLayout" | "activePaneId"> | null,
  onSanitizedChange?: () => void
): boolean {
  if (!dockview || !file?.workspaceLayout) {
    return false;
  }

  try {
    const { changed, layout } = sanitizeSerializedLayout(file.workspaceLayout);
    dockview.fromJSON(layout);
    if (file.activePaneId) {
      focusWorkspacePane(dockview, tabRenderers, file.activePaneId);
    }
    if (changed) {
      onSanitizedChange?.();
    }
    return true;
  } catch {
    return false;
  }
}
