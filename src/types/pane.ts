import type { PaneId } from "./ids";
import type { TerminalRenderer } from "./terminal";

export type PaneCreateDirection = "within" | "left" | "right" | "above" | "below";
export type PaneSplitDirection = Exclude<PaneCreateDirection, "within">;

export type BrowserPaneAdapter = "electrobun-native" | "web-iframe";
export type ExplorerMode = "filetree" | "dirtree" | "filelist";

export type PaneCreateInput =
  | { kind: "terminal"; title?: string; cwd?: string | null; shell?: string | null; renderer?: TerminalRenderer; startupCommands?: string[] }
  | { kind: "browser"; title?: string; url?: string; adapter?: BrowserPaneAdapter }
  | { kind: "editor"; title?: string; filePath?: string | null; language?: string | null }
  | { kind: "explorer"; title?: string; rootPath?: string; mode?: ExplorerMode }
  | { kind: "view"; title?: string; viewKey: string };

export interface PaneResult {
  ok: true;
  paneId: PaneId;
  activePaneId: PaneId | null;
}
