import { createTerminalRuntimeId, type TerminalRuntimeId } from "./ids";

export type TerminalRenderer = "xterm" | "ghostty";
export type BrowserPaneAdapter = "electrobun-native" | "web-iframe";
export type ExplorerMode = "filetree" | "dirtree" | "filelist";
export type PaneKind = "terminal" | "browser" | "editor" | "explorer" | "extension";

export interface TerminalPaneParams {
  kind: "terminal";
  runtimeId: TerminalRuntimeId;
  cwd: string | null;
  shell: string | null;
  renderer: TerminalRenderer;
}

export interface BrowserPaneParams {
  kind: "browser";
  url: string;
  adapter: BrowserPaneAdapter;
}

export interface EditorPaneParams {
  kind: "editor";
  filePath: string | null;
  language: string | null;
}

export interface ExplorerPaneParams {
  kind: "explorer";
  rootPath: string;
  mode: ExplorerMode;
  watchEnabled: boolean;
}

export interface ExtensionPaneParams {
  kind: "extension";
  extensionId: string;
  contributionId: string;
  state?: unknown;
}

export type PaneParams =
  | TerminalPaneParams
  | BrowserPaneParams
  | EditorPaneParams
  | ExplorerPaneParams
  | ExtensionPaneParams;

export type PaneParamsByKind = {
  terminal: TerminalPaneParams;
  browser: BrowserPaneParams;
  editor: EditorPaneParams;
  explorer: ExplorerPaneParams;
  extension: ExtensionPaneParams;
};

export type PaneParamOverridesByKind = {
  terminal: Partial<Omit<TerminalPaneParams, "kind">>;
  browser: Partial<Omit<BrowserPaneParams, "kind">>;
  editor: Partial<Omit<EditorPaneParams, "kind">>;
  explorer: Partial<Omit<ExplorerPaneParams, "kind">>;
  extension: Partial<Omit<ExtensionPaneParams, "kind">>;
};

export function isPaneParams(value: unknown): value is PaneParams {
  return !!value && typeof value === "object" && isPaneKind((value as { kind: unknown }).kind);
}

export function isPaneKind(value: unknown): value is PaneKind {
  return (
    value === "terminal" || value === "browser" || value === "editor" || value === "explorer" || value === "extension"
  );
}

export function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return value === "xterm" || value === "ghostty";
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
    case "extension":
      return "Extension";
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
        renderer: terminalOverrides.renderer ?? "xterm"
      } as PaneParamsByKind[Kind];
    }
    case "browser": {
      const browserOverrides = overrides as PaneParamOverridesByKind["browser"];
      return {
        kind,
        url: browserOverrides.url ?? "about:blank",
        adapter: browserOverrides.adapter ?? "electrobun-native"
      } as PaneParamsByKind[Kind];
    }
    case "editor": {
      const editorOverrides = overrides as PaneParamOverridesByKind["editor"];
      return {
        kind,
        filePath: editorOverrides.filePath ?? null,
        language: editorOverrides.language ?? null
      } as PaneParamsByKind[Kind];
    }
    case "explorer": {
      const explorerOverrides = overrides as PaneParamOverridesByKind["explorer"];
      return {
        kind,
        rootPath: explorerOverrides.rootPath ?? ".",
        mode: explorerOverrides.mode ?? "filetree",
        watchEnabled: explorerOverrides.watchEnabled ?? true
      } as PaneParamsByKind[Kind];
    }
    case "extension": {
      const extensionOverrides = overrides as PaneParamOverridesByKind["extension"];
      return {
        kind,
        extensionId: extensionOverrides.extensionId ?? "sample.cowsay",
        contributionId: extensionOverrides.contributionId ?? "cowsay",
        state: extensionOverrides.state
      } as PaneParamsByKind[Kind];
    }
  }
}
