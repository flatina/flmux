import { css as langCss } from "@codemirror/lang-css";
import { html as langHtml } from "@codemirror/lang-html";
import { javascript as langJs } from "@codemirror/lang-javascript";
import { json as langJson } from "@codemirror/lang-json";
import { markdown as langMd } from "@codemirror/lang-markdown";
import { Compartment } from "@codemirror/state";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { basicSetup, EditorView } from "codemirror";
import { basename } from "node:path";
import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  IDockviewPanelProps,
  PanelUpdateEvent
} from "dockview-core";
import type { WebviewTagElement } from "electrobun/view";
import type { BrowserPaneInfo } from "../shared/app-rpc";
import type { ExtensionRegistryEntry, HeaderAction, MountedExtension, PaneEvent } from "../shared/extension-spi";
import type { TabId } from "../shared/ids";
import { asPaneId, type PaneId, type TerminalRuntimeId } from "../shared/ids";
import type {
  BrowserPaneAdapter,
  BrowserPaneParams,
  EditorPaneParams,
  ExplorerPaneParams,
  ExtensionPaneParams,
  PaneParams,
  TerminalPaneParams
} from "../shared/pane-params";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../shared/rpc";
import {
  browserTitleFromUrl,
  buildNote,
  extractWebviewUrl,
  isBrowserPaneParams,
  isTerminalPaneParams,
  normalizeBrowserUrlValue,
  normalizeUrl
} from "./helpers";
import { getHostRpc } from "./lib/host-rpc";
import { getEditorThemeExtension, getTerminalTheme, onThemeChange } from "./theme";

const hostRpc = getHostRpc();

export type PaneRendererContext = {
  workspaceRoot: string;
  webPort: number | null;
  getTerminalRuntime: (runtimeId: TerminalRuntimeId) => TerminalRuntimeSummary | null;
  getPendingTerminalStartupCommands: (runtimeId: TerminalRuntimeId) => string[] | null;
  clearPendingTerminalStartupCommands: (runtimeId: TerminalRuntimeId) => void;
  getExtensionRegistry: () => ExtensionRegistryEntry[];
  getTabId: () => TabId;
  emitEvent: (source: PaneId, tabId: TabId, eventType: string, data: unknown) => void;
  onEvent: (
    ownerPaneId: PaneId,
    ownerTabId: TabId,
    eventType: string,
    handler: (event: PaneEvent) => void,
    options?: { global?: boolean }
  ) => () => void;
  disposePaneEvents: (paneId: PaneId) => void;
  markDirty: () => void;
  openEditorForFile: (filePath: string, sourcePaneId?: string) => Promise<void>;
  registerPreCloseHook: (paneId: PaneId, hook: () => void) => void;
  unregisterPreCloseHook: (paneId: PaneId) => void;
  firePreCloseHook: (paneId: PaneId) => void;
  subscribeOuterVisibility?: (callback: (visible: boolean) => void) => () => void;
  onHeaderActionsChanged?: (paneId: PaneId, actions: HeaderAction[]) => void;
  setBrowserPaneInfo?: (paneId: PaneId, info: BrowserPaneInfo | null) => void;
};

export class PaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private props: IDockviewPanelProps<PaneParams> | null = null;
  private outerVisible = true;
  private terminalBell = false;
  private terminalPaneId: string | null = null;
  private terminalParams: TerminalPaneParams | null = null;
  private terminalHost: HTMLDivElement | null = null;
  private terminalInstance: Terminal | null = null;
  private terminalFitAddon: FitAddon | null = null;
  private terminalDisposables: Array<() => void> = [];
  private terminalLastRuntime: TerminalRuntimeSummary | null = null;
  private terminalLastSize: { cols: number; rows: number } | null = null;
  private terminalCreatePromise: Promise<void> | null = null;

  private browserPaneId: string | null = null;
  private browserAdapter: BrowserPaneAdapter | null = null;
  private browserInput: HTMLInputElement | null = null;
  private browserWebview: WebviewTagElement | null = null;
  private browserDisposables: Array<() => void> = [];

  private editorPaneId: string | null = null;
  private editorParams: EditorPaneParams | null = null;
  private editorView: EditorView | null = null;
  private editorDirty = false;
  private editorThemeCompartment = new Compartment();
  private editorThemeUnsub: (() => void) | null = null;

  private explorerPaneId: string | null = null;
  private explorerList: HTMLElement | null = null;

  private extensionPaneId: string | null = null;
  private extensionMounted: MountedExtension | null = null;
  private extensionState: unknown = undefined;

  constructor(private readonly context: PaneRendererContext) {
    this.element.className = "pane-shell";
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.props = parameters as unknown as IDockviewPanelProps<PaneParams>;
    this.context.registerPreCloseHook(asPaneId(this.props.api.id), () => this.prepareForClose());
    this.render();
  }

  update(event: PanelUpdateEvent<PaneParams>): void {
    if (!this.props) {
      return;
    }

    this.props = {
      ...this.props,
      params: {
        ...this.props.params,
        ...event.params
      } as PaneParams
    };

    this.render();
  }

  dispose(): void {
    this.disposeTerminalView();
    this.disposeBrowserView();
    this.disposeEditorView();
    this.disposeExtensionView();
    if (this.props) {
      this.context.unregisterPreCloseHook(asPaneId(this.props.api.id));
    }
    if (this.browserPaneId) {
    }
    this.props = null;
    this.element.replaceChildren();
  }

  private prepareForClose(): void {
    if (!this.browserPaneId) {
      return;
    }

    this.disposeBrowserView();
    this.element.replaceChildren();
  }

  private render(): void {
    if (!this.props) {
      return;
    }

    const params = this.props.params;
    if (params.kind === "terminal") {
      this.renderTerminal(params);
      return;
    }

    if (params.kind === "browser") {
      this.renderBrowser(params);
      return;
    }

    if (params.kind === "editor") {
      this.renderEditor(params);
      return;
    }

    if (params.kind === "explorer") {
      this.renderExplorer(params);
      return;
    }

    if (params.kind === "extension") {
      this.renderExtension(params);
      return;
    }

    this.disposeTerminalView();
    this.disposeBrowserView();
    this.disposeExtensionView();
    this.element.replaceChildren(buildNote(`Unknown pane kind: ${(params as PaneParams).kind}`));
  }

  private renderTerminal(params: TerminalPaneParams): void {
    this.disposeBrowserView();

    if (!this.props) {
      return;
    }

    if (
      this.terminalPaneId !== this.props.api.id ||
      !this.terminalInstance ||
      !this.terminalHost ||
      !this.terminalParams ||
      this.terminalParams.runtimeId !== params.runtimeId
    ) {
      this.mountTerminalView(params);
      return;
    }

    this.terminalParams = params;

    this.refreshTerminalRuntime(this.context.getTerminalRuntime(params.runtimeId));
    this.scheduleTerminalFit();
  }

  private renderBrowser(params: BrowserPaneParams): void {
    this.disposeTerminalView();

    if (!this.props) {
      return;
    }

    if (this.browserPaneId !== this.props.api.id || !this.browserInput || !this.browserWebview) {
      this.mountBrowserView(params);
      return;
    }

    this.syncBrowserParams(params);
  }

  private renderEditor(params: EditorPaneParams): void {
    this.disposeTerminalView();
    this.disposeBrowserView();

    if (this.editorPaneId === this.props?.api.id && this.editorView) {
      this.editorParams = params;
      this.syncEditorUi();
      this.refreshEditorHeaderActions();
      return;
    }

    this.disposeEditorView();
    this.editorPaneId = this.props?.api.id ?? null;
    this.editorParams = params;

    const shell = document.createElement("div");
    shell.className = "editor-pane";

    const editorHost = document.createElement("div");
    editorHost.className = "editor-host";

    const statusBar = document.createElement("div");
    statusBar.className = "editor-statusbar";

    const langName = resolveLanguageName(params.filePath, params.language);

    const statusLines = document.createElement("span");
    statusLines.textContent = "1 line";
    const statusEol = document.createElement("span");
    statusEol.textContent = "LF";
    const statusEnc = document.createElement("span");
    statusEnc.textContent = "UTF-8";
    const statusLang = document.createElement("span");
    statusLang.textContent = langName;

    statusBar.append(statusLines, statusEol, statusEnc, statusLang);

    shell.append(editorHost, statusBar);
    this.element.replaceChildren(shell);

    const updateStatus = (doc: { lines: number; toString: () => string }) => {
      statusLines.textContent = `${doc.lines} line${doc.lines !== 1 ? "s" : ""}`;
      statusEol.textContent = doc.toString().includes("\r\n") ? "CRLF" : "LF";
    };

    const langExtension = resolveLanguageExtension(params.filePath, params.language);
    const view = new EditorView({
      doc: "",
      extensions: [
        basicSetup,
        this.editorThemeCompartment.of(getEditorThemeExtension()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.editorDirty = true;
            this.syncEditorUi();
            updateStatus(update.state.doc);
          }
        }),
        EditorView.domEventHandlers({
          keydown: (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              void this.saveEditorFile();
            }
          }
        }),
        ...(langExtension ? [langExtension] : [])
      ],
      parent: editorHost
    });

    this.editorView = view;
    this.editorDirty = false;
    this.editorThemeUnsub = onThemeChange(() => {
      view.dispatch({ effects: this.editorThemeCompartment.reconfigure(getEditorThemeExtension()) });
    });
    this.syncEditorUi();
    this.refreshEditorHeaderActions();

    if (params.filePath) {
      void this.loadEditorFile(params.filePath, updateStatus);
    }
  }

  private disposeEditorView(): void {
    if (this.editorPaneId) {
      this.context.onHeaderActionsChanged?.(asPaneId(this.editorPaneId), []);
    }
    this.editorThemeUnsub?.();
    this.editorThemeUnsub = null;
    this.editorView?.destroy();
    this.editorView = null;
    this.editorPaneId = null;
    this.editorParams = null;
    this.editorDirty = false;
  }

  private async loadEditorFile(
    filePath: string,
    onLoaded?: (doc: { lines: number; toString: () => string }) => void
  ): Promise<void> {
    if (!this.editorView) {
      return;
    }

    const result = await hostRpc.request("fs.readFile", { path: filePath });
    const content = result.ok ? result.content : `[error loading file: ${result.error}]`;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: content }
    });
    this.editorDirty = false;
    this.syncEditorUi();
    onLoaded?.(this.editorView.state.doc);
  }

  private async saveEditorFile(): Promise<void> {
    if (!this.editorView || !this.editorParams) {
      return;
    }

    if (!this.editorParams.filePath) {
      await this.saveEditorFileAs();
      return;
    }

    if (!this.editorDirty) {
      return;
    }

    const result = await hostRpc.request("fs.writeFile", {
      path: this.editorParams.filePath,
      content: this.editorView.state.doc.toString()
    });

    if (result.ok) {
      this.editorDirty = false;
      this.syncEditorUi();
    }
  }

  private async saveEditorFileAs(): Promise<void> {
    if (!this.editorView || !this.editorParams || !this.props) {
      return;
    }

    const suggestedPath = this.editorParams.filePath ?? `${this.context.workspaceRoot}\\untitled.txt`;
    const nextPath = prompt("Save As...", suggestedPath)?.trim();
    if (!nextPath) {
      return;
    }

    const result = await hostRpc.request("fs.writeFile", {
      path: nextPath,
      content: this.editorView.state.doc.toString()
    });

    if (!result.ok) {
      alert(`Save failed: ${result.error}`);
      return;
    }

    this.editorDirty = false;
    this.editorParams = {
      ...this.editorParams,
      filePath: nextPath
    };
    this.props.api.updateParameters({ filePath: nextPath });
    this.props.api.setTitle(basename(nextPath));
    this.syncEditorUi();
    this.refreshEditorHeaderActions();
  }

  private syncEditorUi(): void {
    if (!this.editorParams || !this.props) {
      return;
    }

    this.props.api.setTitle(getEditorTabTitle(this.editorParams.filePath, this.editorDirty));
  }

  private refreshEditorHeaderActions(): void {
    if (!this.editorPaneId) {
      return;
    }

    this.context.onHeaderActionsChanged?.(asPaneId(this.editorPaneId), [
      {
        id: "editor-save",
        icon: "Save",
        tooltip: "Save",
        onClick: () => void this.saveEditorFile()
      },
      {
        id: "editor-save-as",
        icon: "Save As...",
        tooltip: "Save As...",
        onClick: () => void this.saveEditorFileAs()
      }
    ]);
  }

  private renderExplorer(params: ExplorerPaneParams): void {
    this.disposeTerminalView();
    this.disposeBrowserView();

    if (this.explorerPaneId === this.props?.api.id && this.explorerList) {
      return;
    }

    this.explorerPaneId = this.props?.api.id ?? null;

    const shell = document.createElement("div");
    shell.className = "explorer-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "explorer-toolbar";

    const pathLabel = document.createElement("span");
    pathLabel.className = "explorer-path";
    pathLabel.textContent = params.rootPath;

    toolbar.append(pathLabel);

    const list = document.createElement("div");
    list.className = "explorer-list";

    shell.append(toolbar, list);
    this.element.replaceChildren(shell);
    this.explorerList = list;

    void this.loadExplorerDir(params.rootPath, list);
  }

  private async loadExplorerDir(dirPath: string, container: HTMLElement): Promise<void> {
    const result = await hostRpc.request("fs.readDir", { path: dirPath });
    container.replaceChildren();

    for (const entry of result.entries) {
      const row = document.createElement("div");
      row.className = `explorer-entry ${entry.isDir ? "explorer-dir" : "explorer-file"}`;

      const icon = document.createElement("span");
      icon.className = "explorer-icon";
      icon.textContent = entry.isDir ? "\u{1F4C1}" : "\u{1F4C4}";

      const name = document.createElement("span");
      name.className = "explorer-name";
      name.textContent = entry.name;

      row.append(icon, name);

      if (entry.isDir) {
        row.addEventListener("click", () => {
          const pathLabel = this.element.querySelector<HTMLSpanElement>(".explorer-path");
          if (pathLabel) {
            pathLabel.textContent = entry.path;
          }
          void this.loadExplorerDir(entry.path, container);
        });
      } else {
        row.addEventListener("dblclick", () => {
          void this.context.openEditorForFile(entry.path, this.props?.api.id);
        });
      }

      container.append(row);
    }
  }

  private renderExtension(params: ExtensionPaneParams): void {
    this.disposeTerminalView();
    this.disposeBrowserView();

    if (!this.props) return;

    if (this.extensionPaneId === this.props.api.id && this.extensionMounted) {
      return;
    }

    void this.mountExtensionView(params);
  }

  private async mountExtensionView(params: ExtensionPaneParams): Promise<void> {
    if (!this.props) return;

    const paneId = asPaneId(this.props.api.id);
    this.extensionPaneId = this.props.api.id;
    this.extensionState = params.state;

    const host = document.createElement("div");
    host.className = "extension-host";
    host.style.cssText = "width:100%;height:100%;overflow:auto;";
    this.element.replaceChildren(host);

    const loadResult = await hostRpc.request("extension.sourceLoad", { extensionId: params.extensionId });
    if (!loadResult.ok) {
      host.replaceChildren(buildNote(`Extension load failed: ${loadResult.error}`));
      return;
    }

    const sourceWithUrl = `${loadResult.source}\n//# sourceURL=flmux-ext://${params.extensionId}/index.js`;
    const blob = new Blob([sourceWithUrl], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      URL.revokeObjectURL(blobUrl);

      const mountFn = mod.mount ?? mod.default;
      if (typeof mountFn !== "function") {
        host.replaceChildren(buildNote(`Extension ${params.extensionId} has no mount function`));
        return;
      }

      const tabId = this.context.getTabId();
      const context = {
        extensionId: params.extensionId,
        contributionId: params.contributionId,
        paneId,
        tabId,
        initialState: this.extensionState,
        loadAssetText: async (path: string) => {
          const result = await hostRpc.request("extension.assetTextLoad", { extensionId: params.extensionId, path });
          if (!result.ok) {
            throw new Error(result.error);
          }
          return result.content;
        },
        setState: (nextState: unknown) => {
          this.extensionState = nextState;
          this.props?.api.updateParameters({ state: nextState });
        },
        getState: () => this.extensionState,
        emit: (eventType: string, data: unknown) => this.context.emitEvent(paneId, tabId, eventType, data),
        on: (eventType: string, handler: (event: PaneEvent) => void, options?: { global?: boolean }) =>
          this.context.onEvent(paneId, tabId, eventType, handler, options),
        setHeaderActions: (actions: HeaderAction[]) => {
          this.context.onHeaderActionsChanged?.(paneId, actions);
        }
      };

      const mounted = await mountFn(host, context);
      this.extensionMounted = mounted ?? null;
    } catch (err) {
      URL.revokeObjectURL(blobUrl);
      host.replaceChildren(buildNote(`Extension ${params.extensionId} mount error: ${err}`));
    }
  }

  private disposeExtensionView(): void {
    if (this.extensionPaneId) {
      this.context.disposePaneEvents(asPaneId(this.extensionPaneId));
    }
    if (this.extensionMounted) {
      try {
        this.extensionMounted.dispose?.();
      } catch {
        // best effort
      }
      this.extensionMounted = null;
    }
    this.extensionPaneId = null;
    this.extensionState = undefined;
  }

  private mountTerminalView(params: TerminalPaneParams): void {
    if (!this.props) {
      return;
    }

    this.disposeTerminalView();

    this.terminalPaneId = this.props.api.id;
    this.terminalParams = params;
    this.props.api.setTitle("Terminal");

    const host = document.createElement("div");
    host.className = "terminal-host";

    this.element.replaceChildren(host);

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: getTerminalTheme()
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    const inputDisposable = terminal.onData((data) => {
      if (!this.terminalParams) {
        return;
      }

      void hostRpc.request("terminal.input", {
        runtimeId: this.terminalParams.runtimeId,
        data
      });
    });

    host.addEventListener("pointerdown", () => terminal.focus());

    const visibilityDisposable = this.props.api.onDidVisibilityChange(() => this.scheduleTerminalFit());
    const dimensionsDisposable = this.props.api.onDidDimensionsChange(() => this.scheduleTerminalFit());
    const parametersDisposable = this.props.api.onDidParametersChange((nextParams) => {
      if (!isTerminalPaneParams(nextParams)) {
        return;
      }

      if (nextParams.runtimeId !== this.terminalParams?.runtimeId) {
        this.mountTerminalView(nextParams);
        return;
      }

      this.terminalParams = nextParams;

      this.refreshTerminalRuntime(this.context.getTerminalRuntime(nextParams.runtimeId));
      this.scheduleTerminalFit();
    });

    const unsubscribeTerminal = hostRpc.subscribe?.("terminal.event", (event) => this.handleTerminalEvent(event));

    this.terminalHost = host;
    this.terminalInstance = terminal;
    this.terminalFitAddon = fitAddon;
    this.terminalLastRuntime = this.context.getTerminalRuntime(params.runtimeId);
    this.terminalLastSize = null;

    const titleDisposable = terminal.onTitleChange((title) => {
      if (this.props && title) {
        this.props.api.setTitle(title.length > 32 ? `${title.slice(0, 30)}\u2026` : title);
      }
    });

    const bellDisposable = terminal.onBell(() => {
      const isFocused = this.props?.api.isActive && this.outerVisible;
      if (!isFocused) {
        this.terminalBell = true;
        this.syncBellTitle();
      }
      playBellSound();
    });

    const activeDisposable = this.props.api.onDidActiveChange((e) => {
      if (e.isActive && this.terminalBell) {
        this.terminalBell = false;
        this.syncBellTitle();
      }
    });

    const themeUnsub = onThemeChange(() => {
      terminal.options.theme = getTerminalTheme();
    });

    this.terminalDisposables.push(
      () => inputDisposable.dispose(),
      () => visibilityDisposable.dispose(),
      () => dimensionsDisposable.dispose(),
      () => parametersDisposable.dispose(),
      () => titleDisposable.dispose(),
      () => bellDisposable.dispose(),
      () => activeDisposable.dispose(),
      () => unsubscribeTerminal?.(),
      themeUnsub
    );

    // Outer tab visibility: inner panels don't get Dockview visibility events,
    // so we refresh xterm rendering when the outer tab becomes visible again.
    if (this.context.subscribeOuterVisibility) {
      const unsub = this.context.subscribeOuterVisibility((visible) => {
        this.outerVisible = visible;
        if (visible) {
          if (this.props?.api.isActive && this.terminalBell) {
            this.terminalBell = false;
            this.syncBellTitle();
          }
          if (this.terminalInstance) {
            requestAnimationFrame(() => {
              this.terminalInstance?.refresh(0, this.terminalInstance.rows - 1);
            });
          }
        }
      });
      this.terminalDisposables.push(unsub);
    }

    this.refreshTerminalRuntime(this.terminalLastRuntime);
    requestAnimationFrame(() => {
      this.fitTerminal();
      void this.ensureTerminalRuntime();
      this.terminalInstance?.focus();
    });
  }

  private handleTerminalEvent(event: TerminalRuntimeEvent): void {
    const runtimeId = this.terminalParams?.runtimeId;
    if (!runtimeId || !this.terminalInstance) {
      return;
    }

    if (event.type === "output") {
      if (event.runtimeId !== runtimeId) {
        return;
      }

      this.terminalInstance.write(event.data);
      return;
    }

    if (event.type === "state") {
      if (event.runtime.runtimeId !== runtimeId) {
        return;
      }

      const wasRunning = this.terminalLastRuntime?.status === "running";
      this.refreshTerminalRuntime(event.runtime);
      if (wasRunning && event.runtime.status === "exited") {
        this.terminalInstance.writeln(
          `\r\n[flmux] process exited${event.runtime.exitCode === null ? "" : ` (${event.runtime.exitCode})`}`
        );
      }
      if (event.runtime.status === "running") {
        this.scheduleTerminalFit();
      }
      return;
    }

    if (event.runtimeId !== runtimeId) {
      return;
    }

    const exitSuffix = event.exitCode === null ? "" : ` (${event.exitCode})`;
    this.terminalLastRuntime = null;

    this.terminalInstance.writeln(`\r\n[flmux] runtime removed${exitSuffix}`);
  }

  private refreshTerminalRuntime(runtime: TerminalRuntimeSummary | null): void {
    this.terminalLastRuntime = runtime;
    if (!this.terminalParams) {
      return;
    }

    if (!runtime) {
      return;
    }

    if (runtime.status === "running") {
      return;
    }
  }

  private async ensureTerminalRuntime(): Promise<void> {
    if (!this.terminalParams) {
      return;
    }

    const runtime = this.context.getTerminalRuntime(this.terminalParams.runtimeId);
    if (runtime) {
      this.refreshTerminalRuntime(runtime);
      await this.replayScrollback(this.terminalParams.runtimeId);
      return;
    }

    if (this.terminalCreatePromise) {
      return this.terminalCreatePromise;
    }

    const cols = this.terminalLastSize?.cols ?? 120;
    const rows = this.terminalLastSize?.rows ?? 32;
    const runtimeId = this.terminalParams.runtimeId;
    const startupCommands = this.context.getPendingTerminalStartupCommands(runtimeId) ?? undefined;

    this.terminalCreatePromise = hostRpc
      .request("terminal.create", {
        runtimeId,
        paneId: this.terminalPaneId,
        cwd: this.terminalParams.cwd,
        shell: this.terminalParams.shell,
        renderer: this.terminalParams.renderer,
        cols,
        rows,
        workspaceRoot: this.context.workspaceRoot,
        webPort: this.context.webPort,
        startupCommands
      })
      .then((result) => {
        this.context.clearPendingTerminalStartupCommands(runtimeId);
        this.refreshTerminalRuntime(result.terminal);
      })
      .catch((error) => {
        this.terminalInstance?.writeln(
          `\r\n[flmux] failed to start runtime: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        this.terminalCreatePromise = null;
      });
  }

  private async replayScrollback(runtimeId: TerminalRuntimeId): Promise<void> {
    if (!this.terminalInstance) {
      return;
    }

    try {
      const result = await hostRpc.request("terminal.history", { runtimeId });
      if (result.data && this.terminalInstance && this.terminalParams?.runtimeId === runtimeId) {
        this.terminalInstance.write(result.data);
      }
    } catch {
      // best effort — history may be unavailable
    }
  }

  private scheduleTerminalFit(): void {
    if (!this.terminalInstance || !this.terminalFitAddon || !this.terminalParams || !this.props?.api.isVisible) {
      return;
    }

    requestAnimationFrame(() => {
      this.fitTerminal();
    });
  }

  private fitTerminal(): void {
    if (!this.terminalInstance || !this.terminalFitAddon || !this.terminalParams || !this.props?.api.isVisible) {
      return;
    }

    try {
      this.terminalFitAddon.fit();
    } catch {
      return;
    }

    const nextSize = {
      cols: this.terminalInstance.cols,
      rows: this.terminalInstance.rows
    };

    if (nextSize.cols <= 0 || nextSize.rows <= 0) {
      return;
    }

    if (
      this.terminalLastSize &&
      this.terminalLastSize.cols === nextSize.cols &&
      this.terminalLastSize.rows === nextSize.rows
    ) {
      return;
    }

    this.terminalLastSize = nextSize;

    if (!this.context.getTerminalRuntime(this.terminalParams.runtimeId)) {
      return;
    }

    void hostRpc.request("terminal.resize", {
      runtimeId: this.terminalParams.runtimeId,
      cols: nextSize.cols,
      rows: nextSize.rows
    });
  }

  private syncBellTitle(): void {
    if (!this.props) return;
    const current = this.props.api.title ?? "Terminal";
    if (this.terminalBell) {
      if (!current.startsWith("\u{1F514} ")) {
        this.props.api.setTitle(`\u{1F514} ${current}`);
      }
    } else {
      if (current.startsWith("\u{1F514} ")) {
        this.props.api.setTitle(current.slice(3));
      }
    }
  }

  private disposeTerminalView(): void {
    for (const dispose of this.terminalDisposables) {
      dispose();
    }

    this.terminalDisposables.length = 0;
    this.terminalInstance?.dispose();
    this.terminalBell = false;
    this.terminalPaneId = null;
    this.terminalParams = null;
    this.terminalHost = null;
    this.terminalInstance = null;
    this.terminalFitAddon = null;
    this.terminalLastRuntime = null;
    this.terminalLastSize = null;
    this.terminalCreatePromise = null;
  }

  private mountBrowserView(params: BrowserPaneParams): void {
    if (!this.props) {
      return;
    }

    // Web environment: use iframe instead of native webview
    const runtime = window as Window & { __electrobun?: unknown; __electrobunWindowId?: unknown };
    const isElectrobunRuntime =
      typeof runtime.__electrobun !== "undefined" || typeof runtime.__electrobunWindowId === "number";
    if (!isElectrobunRuntime) {
      this.mountBrowserIframe(params);
      return;
    }

    this.disposeBrowserView();

    this.browserPaneId = this.props.api.id;
    this.browserAdapter = "electrobun-native";

    const shell = document.createElement("div");
    shell.className = "browser-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "browser-toolbar";

    const backBtn = document.createElement("button");
    backBtn.className = "browser-nav-btn";
    backBtn.type = "button";
    backBtn.textContent = "\u2190";
    backBtn.addEventListener("click", () => {
      const webview = this.browserWebview;
      if (!webview) {
        return;
      }

      try {
        webview.executeJavascript("history.back()");
      } catch {
        webview.goBack();
      }
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "browser-nav-btn";
    refreshBtn.type = "button";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.addEventListener("click", () => {
      const webview = this.browserWebview;
      if (!webview) {
        return;
      }

      try {
        webview.executeJavascript("window.location.reload()");
      } catch {
        webview.reload();
      }
    });

    const address = document.createElement("input");
    address.className = "browser-address";
    address.type = "text";
    address.spellcheck = false;
    address.autocomplete = "off";
    address.placeholder = "Search or enter URL";

    toolbar.append(backBtn, refreshBtn, address);

    const isBlank = !params.url || params.url === "about:blank";
    const welcome = createBrowserWelcome();

    const syncVisibility = () => {
      if (!this.props || !this.browserWebview) {
        return;
      }

      const visible = this.props.api.isVisible;
      this.browserWebview.toggleHidden(!visible);
      this.browserWebview.togglePassthrough(!visible);
      if (visible) {
        this.browserWebview.syncDimensions(true);
      }
    };

    const syncDimensions = () => {
      this.browserWebview?.syncDimensions(true);
    };

    const handleDidNavigate = (event: CustomEvent) => {
      const url = extractWebviewUrl(event.detail);
      if (!url) {
        return;
      }

      if (this.browserInput && this.browserInput !== document.activeElement) {
        this.browserInput.value = url;
      }

      if (this.props?.params.kind === "browser" && this.props.params.url !== url) {
        this.props.api.updateParameters({ url });
      }
      this.props?.api.setTitle(browserTitleFromUrl(url));
      this.context.markDirty();
      this.emitBrowserPaneInfo(url);
      void this.injectBrowserPaneMarker();
    };

    // Lazily create the webview — Electrobun navigates to a default page on DOM insert,
    // so we defer creation until the user actually navigates (same pattern as multitab-browser).
    // Set src BEFORE appending to DOM — Electrobun loads its default page on insert,
    // so the src attribute must already be set (same pattern as multitab-browser).
    const ensureWebview = (url: string): WebviewTagElement => {
      if (this.browserWebview) return this.browserWebview;

      const webview = document.createElement("electrobun-webview") as WebviewTagElement;
      webview.className = "browser-webview";
      webview.renderer = "native";
      webview.setAttribute("src", url);

      webview.on("dom-ready", () => {
        syncDimensions();
        this.emitBrowserPaneInfo();
        void this.injectBrowserPaneMarker();
      });
      webview.on("did-navigate", handleDidNavigate);
      webview.on("did-commit-navigation", handleDidNavigate);

      this.browserDisposables.push(
        () => webview.off("did-navigate", handleDidNavigate),
        () => webview.off("did-commit-navigation", handleDidNavigate)
      );

      shell.appendChild(webview);
      this.browserWebview = webview;
      this.emitBrowserPaneInfo();

      requestAnimationFrame(() => syncVisibility());
      return webview;
    };

    const dismissWelcome = () => {
      welcome.style.display = "none";
    };

    const navigateToUrl = (url: string) => {
      dismissWelcome();
      ensureWebview(url);
      this.navigateBrowser(url);
    };

    const navigate = () => {
      navigateToUrl(normalizeUrl(address.value));
    };

    address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        navigate();
      }
    });

    const visibilityDisposable = this.props.api.onDidVisibilityChange(() => syncVisibility());
    const dimensionsDisposable = this.props.api.onDidDimensionsChange(() => syncDimensions());
    const parametersDisposable = this.props.api.onDidParametersChange((nextParams) => {
      if (!isBrowserPaneParams(nextParams)) {
        return;
      }

      this.syncBrowserParams(nextParams);
    });

    this.browserDisposables.push(
      () => visibilityDisposable.dispose(),
      () => dimensionsDisposable.dispose(),
      () => parametersDisposable.dispose()
    );

    // When nested inside a layoutable tab, outer tab switches must hide/show the overlay
    if (this.context.subscribeOuterVisibility) {
      const unsub = this.context.subscribeOuterVisibility((outerVisible) => {
        if (!outerVisible) {
          this.browserWebview?.toggleHidden(true);
          this.browserWebview?.togglePassthrough(true);
        } else {
          syncVisibility();
        }
      });
      this.browserDisposables.push(unsub);
    }

    welcome.querySelector(".browser-welcome-input")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        navigateToUrl(normalizeUrl((e.target as HTMLInputElement).value));
      }
    });
    welcome.querySelectorAll<HTMLButtonElement>(".browser-welcome-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.url) navigateToUrl(btn.dataset.url);
      });
    });

    if (isBlank) {
      shell.append(toolbar, welcome);
      this.element.replaceChildren(shell);
      this.browserInput = address;
      this.emitBrowserPaneInfo();
    } else {
      welcome.style.display = "none";
      shell.append(toolbar, welcome);
      this.element.replaceChildren(shell);
      this.browserInput = address;
      ensureWebview(normalizeBrowserUrlValue(params.url));
      this.syncBrowserParams(params);
      requestAnimationFrame(() => syncVisibility());
    }
  }

  private mountBrowserIframe(params: BrowserPaneParams): void {
    if (!this.props) return;

    this.disposeBrowserView();
    this.browserPaneId = this.props.api.id;
    this.browserAdapter = "web-iframe";

    const shell = document.createElement("div");
    shell.className = "browser-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "browser-toolbar";

    const backBtn = document.createElement("button");
    backBtn.className = "browser-nav-btn";
    backBtn.type = "button";
    backBtn.textContent = "\u2190";
    backBtn.addEventListener("click", () => {
      try {
        iframe.contentWindow?.history.back();
      } catch {
        /* cross-origin */
      }
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "browser-nav-btn";
    refreshBtn.type = "button";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.addEventListener("click", () => {
      iframe.src = normalizeUrl(address.value);
    });

    const address = document.createElement("input");
    address.className = "browser-address";
    address.type = "text";
    address.spellcheck = false;
    address.autocomplete = "off";
    address.placeholder = "Search or enter URL";
    address.value = normalizeBrowserUrlValue(params.url);

    const iframe = document.createElement("iframe");
    iframe.className = "browser-webview";
    iframe.style.cssText = "width:100%;flex:1;border:none;";
    iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
    iframe.src = normalizeUrl(params.url);

    address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const url = normalizeUrl(address.value);
        iframe.src = url;
        this.props?.api.updateParameters({ url });
        this.props?.api.setTitle(browserTitleFromUrl(url));
        this.context.markDirty();
      }
    });

    toolbar.append(backBtn, refreshBtn, address);

    const welcome = createBrowserWelcome();
    const isBlank = !params.url || params.url === "about:blank";
    welcome.style.display = isBlank ? "" : "none";
    if (isBlank) iframe.style.display = "none";

    const navigateFromWelcome = (url: string) => {
      address.value = url;
      iframe.src = url;
      iframe.style.display = "";
      welcome.style.display = "none";
      this.props?.api.updateParameters({ url });
      this.props?.api.setTitle(browserTitleFromUrl(url));
      this.context.markDirty();
    };

    welcome.querySelector(".browser-welcome-input")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        navigateFromWelcome(normalizeUrl((e.target as HTMLInputElement).value));
      }
    });
    welcome.querySelectorAll<HTMLButtonElement>(".browser-welcome-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.url) navigateFromWelcome(btn.dataset.url);
      });
    });

    shell.append(toolbar, welcome, iframe);
    this.element.replaceChildren(shell);
    this.browserInput = address;
    this.props.api.setTitle(browserTitleFromUrl(params.url));
    this.emitBrowserPaneInfo(iframe.src);
  }

  private syncBrowserParams(params: BrowserPaneParams): void {
    if (!this.browserInput || !this.browserWebview) {
      return;
    }

    const normalizedUrl = normalizeBrowserUrlValue(params.url);
    if (this.props?.params.kind === "browser" && normalizedUrl !== params.url) {
      this.props.api.updateParameters({ url: normalizedUrl });
      this.context.markDirty();
    }

    if (this.browserInput !== document.activeElement) {
      this.browserInput.value = normalizedUrl;
    }

    if (normalizedUrl !== "about:blank" && this.browserWebview.src !== normalizedUrl) {
      this.browserWebview.loadURL(normalizedUrl);
    }
    this.browserWebview.syncDimensions(true);
    this.emitBrowserPaneInfo(normalizedUrl);
  }

  private navigateBrowser(url: string): void {
    if (!this.props || !this.browserInput || !this.browserWebview) {
      return;
    }

    this.browserInput.value = url;
    this.browserWebview.loadURL(url);
    this.browserWebview.syncDimensions(true);
    this.props.api.updateParameters({ url });
    this.props.api.setTitle(browserTitleFromUrl(url));
    this.context.markDirty();
    this.emitBrowserPaneInfo(url);
  }

  private disposeBrowserView(): void {
    for (const dispose of this.browserDisposables) {
      dispose();
    }

    this.browserDisposables.length = 0;

    if (this.browserWebview) {
      const el = this.browserWebview;
      el.toggleHidden?.(true);
      el.togglePassthrough?.(true);
      el.remove();
      this.browserWebview = null;
    }

    if (this.browserPaneId) {
      this.context.setBrowserPaneInfo?.(asPaneId(this.browserPaneId), null);
    }
    this.browserPaneId = null;
    this.browserAdapter = null;
    this.browserInput = null;
  }

  private async injectBrowserPaneMarker(): Promise<void> {
    if (!this.browserWebview || !this.browserPaneId) {
      return;
    }

    try {
      const marker = `__FLMUX_PANE__:${this.browserPaneId}`;
      this.browserWebview.executeJavascript(`
        (() => {
          window.name = ${JSON.stringify(marker)};
          if (window.__flmuxBrowserRpcReady) return;
          window.__flmuxBrowserRpcReady = true;
          const original = window.__electrobun?.receiveMessageFromBun;
          window.__electrobun.receiveMessageFromBun = async (msg) => {
            if (msg?.type !== "request" || msg.method !== "evaluateJavascriptWithResponse") {
              if (typeof original === "function") original(msg);
              return;
            }
            try {
              const resultFn = new Function(msg.params?.script ?? "");
              let result = resultFn();
              if (result instanceof Promise) result = await result;
              window.__electrobunBunBridge?.postMessage(JSON.stringify({
                type: "response",
                id: msg.id,
                success: true,
                payload: result
              }));
            } catch (error) {
              window.__electrobunBunBridge?.postMessage(JSON.stringify({
                type: "response",
                id: msg.id,
                success: false,
                error: error instanceof Error ? error.message : String(error)
              }));
            }
          };
        })();
      `);
    } catch {
      // best effort
    }
  }

  private emitBrowserPaneInfo(nextUrl?: string | null): void {
    if (!this.context.setBrowserPaneInfo || !this.props || this.props.params.kind !== "browser") {
      return;
    }

    const adapter = this.browserAdapter ?? this.props.params.adapter;
    const url = normalizeBrowserUrlValue(nextUrl ?? this.browserInput?.value ?? this.props.params.url);
    const title = this.props.api.title ?? browserTitleFromUrl(url);
    const webviewId = typeof this.browserWebview?.webviewId === "number" ? this.browserWebview.webviewId : null;

    let automationStatus: BrowserPaneInfo["automationStatus"] = "pending";
    let automationReason: string | undefined;
    if (adapter === "web-iframe") {
      automationStatus = "unsupported";
      automationReason = "iframe browser panes do not expose CDP automation";
    } else if (webviewId !== null) {
      automationStatus = "ready";
    } else {
      automationReason = "native browser pane has not finished creating its webview";
    }

    const paneId = asPaneId(this.props.api.id);
    this.context.setBrowserPaneInfo(paneId, {
      paneId,
      tabId: this.context.getTabId(),
      title,
      url,
      adapter,
      webviewId,
      automationStatus,
      automationReason
    });
  }
}

function playBellSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 800;
    gain.gain.value = 0.08;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => ctx.close();
  } catch {
    // ignore — audio not available
  }
}

function resolveLanguageName(filePath: string | null, language: string | null): string {
  const hint = language ?? filePath?.split(".").pop()?.toLowerCase() ?? "";
  switch (hint) {
    case "js":
    case "mjs":
    case "cjs":
    case "javascript":
      return "JavaScript";
    case "ts":
    case "mts":
    case "cts":
    case "typescript":
      return "TypeScript";
    case "tsx":
      return "TSX";
    case "jsx":
      return "JSX";
    case "json":
    case "jsonc":
      return "JSON";
    case "html":
    case "htm":
      return "HTML";
    case "css":
      return "CSS";
    case "md":
    case "markdown":
      return "Markdown";
    case "yaml":
    case "yml":
      return "YAML";
    case "toml":
      return "TOML";
    case "sh":
    case "bash":
    case "zsh":
      return "Shell";
    default:
      return hint ? hint.toUpperCase() : "Plain Text";
  }
}

function resolveLanguageExtension(filePath: string | null, language: string | null) {
  const hint = language ?? filePath?.split(".").pop()?.toLowerCase() ?? "";
  switch (hint) {
    case "js":
    case "mjs":
    case "cjs":
    case "javascript":
      return langJs();
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
    case "jsx":
    case "typescript":
      return langJs({ typescript: true, jsx: hint === "tsx" || hint === "jsx" });
    case "json":
    case "jsonc":
      return langJson();
    case "html":
    case "htm":
      return langHtml();
    case "css":
      return langCss();
    case "md":
    case "markdown":
      return langMd();
    default:
      return null;
  }
}

function getEditorTabTitle(filePath: string | null, dirty: boolean): string {
  const base = filePath ? basename(filePath) : "Untitled";
  return dirty ? `${base} *` : base;
}

function createBrowserWelcome(): HTMLElement {
  const el = document.createElement("div");
  el.className = "browser-welcome";
  el.innerHTML = `<div class="browser-welcome-card">
  <div class="browser-welcome-title">flmux</div>
  <div class="browser-welcome-subtitle">Search or enter a URL to get started</div>
  <input class="browser-welcome-input" type="text" placeholder="Search or enter URL" spellcheck="false" autocomplete="off" />
  <div class="browser-welcome-links">
    <button type="button" class="browser-welcome-link" data-url="https://www.google.com">Google</button>
    <button type="button" class="browser-welcome-link" data-url="https://github.com">GitHub</button>
    <button type="button" class="browser-welcome-link" data-url="https://developer.mozilla.org">MDN</button>
  </div>
</div>`;
  return el;
}
