import type { SerializedDockview } from "dockview-core";
import type { PaneId } from "../../lib/ids";

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface FlmuxLastFile {
  schemaVersion: 1 | 2;
  name?: string;
  savedAt: string;
  activePaneId: PaneId | null;
  workspaceLayout: SerializedDockview | null;
  window?: WindowFrame;
}

export function createFlmuxLastFile(input: {
  activePaneId: PaneId | null;
  workspaceLayout: SerializedDockview | null;
  window?: WindowFrame;
}): FlmuxLastFile {
  return {
    schemaVersion: 2,
    savedAt: new Date().toISOString(),
    activePaneId: input.activePaneId,
    workspaceLayout: input.workspaceLayout,
    window: input.window
  };
}
