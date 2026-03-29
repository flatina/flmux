import { createTerminalRuntimeId, type TerminalRuntimeId } from "../../lib/ids";
import type { TerminalRenderer } from "../../types/terminal";
import type { BrowserPaneAdapter, ExplorerMode } from "../../types/pane";

export { isTerminalRenderer } from "../../types/terminal";
export type { TerminalRenderer } from "../../types/terminal";
export type { BrowserPaneAdapter, ExplorerMode } from "../../types/pane";
export type PaneKind = "terminal" | "browser" | "editor" | "explorer" | "view";

interface PaneStateCarrier {
  state?: unknown;
}

export interface TerminalPaneParams extends PaneStateCarrier {
  kind: "terminal";
  runtimeId: TerminalRuntimeId;
  cwd: string | null;
  shell: string | null;
  renderer: TerminalRenderer;
  startupCommands?: string[];
}

export interface BrowserPaneParams extends PaneStateCarrier {
  kind: "browser";
  url: string;
  adapter: BrowserPaneAdapter;
}

export interface EditorPaneParams extends PaneStateCarrier {
  kind: "editor";
  filePath: string | null;
  language: string | null;
}

export interface ExplorerPaneParams extends PaneStateCarrier {
  kind: "explorer";
  rootPath: string;
  mode: ExplorerMode;
}

export interface ViewPaneParams {
  kind: "view";
  viewKey: string;
  state?: unknown;
}

export type PaneParams =
  | TerminalPaneParams
  | BrowserPaneParams
  | EditorPaneParams
  | ExplorerPaneParams
  | ViewPaneParams;

export type PaneParamsByKind = {
  terminal: TerminalPaneParams;
  browser: BrowserPaneParams;
  editor: EditorPaneParams;
  explorer: ExplorerPaneParams;
  view: ViewPaneParams;
};

export type PaneParamOverridesByKind = {
  terminal: Partial<Omit<TerminalPaneParams, "kind">>;
  browser: Partial<Omit<BrowserPaneParams, "kind">>;
  editor: Partial<Omit<EditorPaneParams, "kind">>;
  explorer: Partial<Omit<ExplorerPaneParams, "kind">>;
  view: Partial<Omit<ViewPaneParams, "kind">>;
};

export function isPaneParams(value: unknown): value is PaneParams {
  return !!value && typeof value === "object" && isPaneKind((value as { kind: unknown }).kind);
}

export function isPaneKind(value: unknown): value is PaneKind {
  return value === "terminal" || value === "browser" || value === "editor" || value === "explorer" || value === "view";
}

export function isBrowserPaneAdapter(value: unknown): value is BrowserPaneAdapter {
  return value === "electrobun-native" || value === "web-iframe";
}

export function isExplorerMode(value: unknown): value is ExplorerMode {
  return value === "filetree" || value === "dirtree" || value === "filelist";
}

export function getDefaultPaneTitle(kind: PaneKind): string {
  switch (kind) {
    case "terminal":
      return "Terminal";
    case "browser":
      return "Browser";
    case "editor":
      return "Editor";
    case "explorer":
      return "Explorer";
    case "view":
      return "View";
  }
}

export function createPaneParams<Kind extends PaneKind>(
  kind: Kind,
  overrides: PaneParamOverridesByKind[Kind] = {} as PaneParamOverridesByKind[Kind]
): PaneParamsByKind[Kind] {
  switch (kind) {
    case "terminal": {
      const terminalOverrides = overrides as PaneParamOverridesByKind["terminal"];
      return {
        kind,
        runtimeId: terminalOverrides.runtimeId ?? createTerminalRuntimeId(),
        cwd: terminalOverrides.cwd ?? null,
        shell: terminalOverrides.shell ?? null,
        renderer: terminalOverrides.renderer ?? "xterm",
        startupCommands: terminalOverrides.startupCommands,
        state: terminalOverrides.state
      } as PaneParamsByKind[Kind];
    }
    case "browser": {
      const browserOverrides = overrides as PaneParamOverridesByKind["browser"];
      return {
        kind,
        url: browserOverrides.url ?? "about:blank",
        adapter: browserOverrides.adapter ?? "electrobun-native",
        state: browserOverrides.state
      } as PaneParamsByKind[Kind];
    }
    case "editor": {
      const editorOverrides = overrides as PaneParamOverridesByKind["editor"];
      return {
        kind,
        filePath: editorOverrides.filePath ?? null,
        language: editorOverrides.language ?? null,
        state: editorOverrides.state
      } as PaneParamsByKind[Kind];
    }
    case "explorer": {
      const explorerOverrides = overrides as PaneParamOverridesByKind["explorer"];
      return {
        kind,
        rootPath: explorerOverrides.rootPath ?? ".",
        mode: explorerOverrides.mode ?? "filetree",
        state: explorerOverrides.state
      } as PaneParamsByKind[Kind];
    }
    case "view": {
      const panelOverrides = overrides as PaneParamOverridesByKind["view"];
      return {
        kind,
        viewKey: panelOverrides.viewKey ?? "sample.cowsay:cowsay",
        state: panelOverrides.state
      } as PaneParamsByKind[Kind];
    }
  }
}
