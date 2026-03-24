import { css as langCss } from "@codemirror/lang-css";
import { html as langHtml } from "@codemirror/lang-html";
import { javascript as langJs } from "@codemirror/lang-javascript";
import { json as langJson } from "@codemirror/lang-json";
import { markdown as langMd } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { basicSetup, EditorView } from "codemirror";
import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  IDockviewPanelProps,
  PanelUpdateEvent
} from "dockview-core";
import type { BrowserPaneInfo } from "../shared/app-rpc";
import type { WebviewTagElement } from "electrobun/view";
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

const hostRpc = getHostRpc();

export type BrowserAutomationHandle = {
  connect: () => Promise<{
    ok: true;
    paneId: PaneId;
    url: string | null;
    title: string;
    adapter: BrowserPaneAdapter;
    webviewId: number | null;
  }>;
  navigate: (params: { url: string; waitUntil?: "none" | "load" | "idle"; idleMs?: number }) => Promise<{
    ok: true;
    paneId: PaneId;
    url: string;
  }>;
  get: (field: "url" | "title") => Promise<{ ok: true; paneId: PaneId; field: "url" | "title"; value: string }>;
  snapshot: (params: { compact?: boolean }) => Promise<{ ok: true; paneId: PaneId; snapshot: string }>;
  click: (params: { target: string }) => Promise<{ ok: true; paneId: PaneId }>;
  fill: (params: { target: string; text: string }) => Promise<{ ok: true; paneId: PaneId }>;
  press: (params: { key: string }) => Promise<{ ok: true; paneId: PaneId }>;
  wait: (params: { kind: "duration" | "load" | "idle" | "target"; target?: string; ms?: number }) => Promise<{
    ok: true;
    paneId: PaneId;
  }>;
};

export type PaneRendererContext = {
  workspaceRoot: string;
  getTerminalRuntime: (runtimeId: TerminalRuntimeId) => TerminalRuntimeSummary | null;
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
  registerBrowserAutomationHandle?: (paneId: PaneId, handle: BrowserAutomationHandle) => void;
  unregisterBrowserAutomationHandle?: (paneId: PaneId) => void;
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
  private browserMessageSeq = 0;
  private browserPendingMessages = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private editorPaneId: string | null = null;
  private editorView: EditorView | null = null;
  private editorDirty = false;

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
      this.context.unregisterBrowserAutomationHandle?.(asPaneId(this.browserPaneId));
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
      return;
    }

    this.disposeEditorView();
    this.editorPaneId = this.props?.api.id ?? null;

    const shell = document.createElement("div");
    shell.className = "editor-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar";

    const pathLabel = document.createElement("span");
    pathLabel.className = "editor-path";
    pathLabel.textContent = params.filePath ?? "(no file)";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.className = "editor-save";
    saveBtn.addEventListener("click", () => void this.saveEditorFile(params));

    toolbar.append(pathLabel, saveBtn);

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

    shell.append(toolbar, editorHost, statusBar);
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
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.editorDirty = true;
            saveBtn.textContent = "Save *";
            updateStatus(update.state.doc);
          }
        }),
        EditorView.domEventHandlers({
          keydown: (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              void this.saveEditorFile(params);
            }
          }
        }),
        ...(langExtension ? [langExtension] : [])
      ],
      parent: editorHost
    });

    this.editorView = view;
    this.editorDirty = false;

    if (params.filePath) {
      void this.loadEditorFile(params.filePath, updateStatus);
    }
  }

  private disposeEditorView(): void {
    this.editorView?.destroy();
    this.editorView = null;
    this.editorPaneId = null;
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
    onLoaded?.(this.editorView.state.doc);
  }

  private async saveEditorFile(params: EditorPaneParams): Promise<void> {
    if (!params.filePath || !this.editorView || !this.editorDirty) {
      return;
    }

    const result = await hostRpc.request("fs.writeFile", {
      path: params.filePath,
      content: this.editorView.state.doc.toString()
    });

    if (result.ok) {
      this.editorDirty = false;
      const saveBtn = this.element.querySelector<HTMLButtonElement>(".editor-save");
      if (saveBtn) {
        saveBtn.textContent = "Save";
      }
    }
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
      theme: {
        background: "#0b1016",
        foreground: "#e8edf2",
        cursor: "#ffad5a",
        cursorAccent: "#0b1016",
        selectionBackground: "rgba(255, 173, 90, 0.25)"
      }
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

    this.terminalDisposables.push(
      () => inputDisposable.dispose(),
      () => visibilityDisposable.dispose(),
      () => dimensionsDisposable.dispose(),
      () => parametersDisposable.dispose(),
      () => titleDisposable.dispose(),
      () => bellDisposable.dispose(),
      () => activeDisposable.dispose(),
      () => unsubscribeTerminal?.()
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

    this.terminalCreatePromise = hostRpc
      .request("terminal.create", {
        runtimeId: this.terminalParams.runtimeId,
        paneId: this.terminalPaneId,
        cwd: this.terminalParams.cwd,
        shell: this.terminalParams.shell,
        renderer: this.terminalParams.renderer,
        cols,
        rows,
        workspaceRoot: this.context.workspaceRoot
      })
      .then((result) => {
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
    this.context.registerBrowserAutomationHandle?.(asPaneId(this.browserPaneId), this.createBrowserAutomationHandle());

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

    const handleHostMessage = (event: CustomEvent) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") {
        return;
      }

      const payload = detail as { __flmuxBrowserEval?: string; ok?: boolean; value?: unknown; error?: string };
      if (typeof payload.__flmuxBrowserEval !== "string") {
        return;
      }

      const pending = this.browserPendingMessages.get(payload.__flmuxBrowserEval);
      if (!pending) {
        return;
      }

      this.browserPendingMessages.delete(payload.__flmuxBrowserEval);
      clearTimeout(pending.timer);
      if (payload.ok === false) {
        pending.reject(new Error(payload.error ?? "Browser evaluation failed"));
      } else {
        pending.resolve(payload.value);
      }
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
      webview.on("host-message", handleHostMessage);

      this.browserDisposables.push(
        () => webview.off("did-navigate", handleDidNavigate),
        () => webview.off("did-commit-navigation", handleDidNavigate),
        () => webview.off("host-message", handleHostMessage)
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
      btn.addEventListener("click", () => { if (btn.dataset.url) navigateToUrl(btn.dataset.url); });
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
    this.context.registerBrowserAutomationHandle?.(asPaneId(this.browserPaneId), this.createBrowserAutomationHandle());

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
      btn.addEventListener("click", () => { if (btn.dataset.url) navigateFromWelcome(btn.dataset.url); });
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
      this.context.unregisterBrowserAutomationHandle?.(asPaneId(this.browserPaneId));
    }
    this.browserPaneId = null;
    this.browserAdapter = null;
    this.browserInput = null;
    for (const [, pending] of this.browserPendingMessages) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser pane disposed"));
    }
    this.browserPendingMessages.clear();
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

  private createBrowserAutomationHandle(): BrowserAutomationHandle {
    return {
      connect: async () => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        const [url, title] = await Promise.all([
          this.evalBrowserScript<string>("window.location.href"),
          this.evalBrowserScript<string>("document.title")
        ]);
        return {
          ok: true,
          paneId,
          url,
          title,
          adapter: this.browserAdapter ?? "electrobun-native",
          webviewId: typeof this.browserWebview?.webviewId === "number" ? this.browserWebview.webviewId : null
        };
      },
      navigate: async ({ url, waitUntil, idleMs }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        const normalizedUrl = normalizeUrl(url);
        this.navigateBrowser(normalizedUrl);
        if (waitUntil !== "none") {
          await this.waitForBrowserLoad(idleMs ?? 500, waitUntil === "idle");
        }
        return {
          ok: true,
          paneId,
          url: await this.evalBrowserScript<string>("window.location.href")
        };
      },
      get: async (field) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        const value = await this.evalBrowserScript<string>(field === "url" ? "window.location.href" : "document.title");
        return { ok: true, paneId, field, value };
      },
      snapshot: async ({ compact }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        const snapshot = await this.evalBrowserScript<string>(buildSnapshotExpression(!!compact));
        return { ok: true, paneId, snapshot };
      },
      click: async ({ target }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        await this.evalBrowserScript(
          `(() => {
            const el = ${buildResolveTargetExpression(target)};
            if (!(el instanceof HTMLElement)) throw new Error('Target not found: ' + ${JSON.stringify(target)});
            setTimeout(() => el.click(), 0);
            return true;
          })()`
        );
        return { ok: true, paneId };
      },
      fill: async ({ target, text }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        await this.evalBrowserScript(
          `(() => {
            const el = ${buildResolveTargetExpression(target)};
            if (!(el instanceof HTMLElement)) throw new Error('Target not found: ' + ${JSON.stringify(target)});
            const input = el;
            if (!('value' in input)) throw new Error('Target is not fillable: ' + ${JSON.stringify(target)});
            input.focus();
            const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSet) nativeSet.call(input, ${JSON.stringify(text)});
            else input.value = ${JSON.stringify(text)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`
        );
        return { ok: true, paneId };
      },
      press: async ({ key }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        await this.evalBrowserScript(
          `(() => {
            const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
            const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
            setTimeout(() => {
              target.dispatchEvent(new KeyboardEvent('keydown', init));
              target.dispatchEvent(new KeyboardEvent('keyup', init));
            }, 0);
            return true;
          })()`
        );
        return { ok: true, paneId };
      },
      wait: async ({ kind, target, ms }) => {
        const paneId = this.requireBrowserPaneId();
        this.ensureBrowserAutomationReady();
        if (kind === "duration") {
          await new Promise((resolve) => setTimeout(resolve, ms ?? 0));
        } else if (kind === "load") {
          await this.waitForBrowserLoad(0, false);
        } else if (kind === "idle") {
          await this.waitForBrowserLoad(ms ?? 500, true);
        } else {
          await this.waitForTarget(target ?? "");
        }
        return { ok: true, paneId };
      }
    };
  }

  private requireBrowserPaneId(): PaneId {
    if (!this.browserPaneId) {
      throw new Error("Browser pane is not mounted");
    }

    return asPaneId(this.browserPaneId);
  }

  private ensureBrowserAutomationReady(): void {
    if (this.browserAdapter === "web-iframe") {
      throw new Error("iframe browser panes do not expose automation");
    }
    if (!this.browserWebview || typeof this.browserWebview.webviewId !== "number") {
      throw new Error("browser pane has not finished creating its native webview");
    }
  }

  private async evalBrowserScript<T>(expression: string, timeoutMs = 10_000): Promise<T> {
    if (!this.browserWebview || !this.browserPaneId) {
      throw new Error("Browser pane is not ready");
    }

    const requestId = `${this.browserPaneId}:${++this.browserMessageSeq}`;
    const js = `
      (() => {
        const send = (payload) => window.__electrobunSendToHost?.({ __flmuxBrowserEval: ${JSON.stringify(requestId)}, ...payload });
        Promise.resolve()
          .then(() => (${expression}))
          .then((value) => send({ ok: true, value }))
          .catch((error) => send({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      })();
    `;

    return new Promise<T>((resolve, reject) => {
      const webview = this.browserWebview;
      if (!webview) {
        reject(new Error("Browser pane is not ready"));
        return;
      }

      const timer = setTimeout(() => {
        this.browserPendingMessages.delete(requestId);
        reject(new Error(`Timed out waiting for browser script: ${expression}`));
      }, timeoutMs);

      this.browserPendingMessages.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });

      try {
        webview.executeJavascript(js);
      } catch (error) {
        clearTimeout(timer);
        this.browserPendingMessages.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async waitForBrowserLoad(idleMs: number, includeIdle: boolean): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ready = await this.evalBrowserScript<string>("document.readyState");
      if (ready === "complete") {
        if (includeIdle && idleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, idleMs));
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out waiting for browser load");
  }

  private async waitForTarget(target: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const exists = await this.evalBrowserScript<boolean>(
        `(() => !!(${buildResolveTargetExpression(target)}))()`
      );
      if (exists) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for target: ${target}`);
  }
}

function buildSnapshotExpression(compact: boolean): string {
  return `(() => {
    const selectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      '[tabindex]'
    ];
    const seen = new Set();
    const lines = [];
    let counter = 0;
    document.querySelectorAll('[data-flmux-ref]').forEach((el) => el.removeAttribute('data-flmux-ref'));
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const roleOf = (el) => {
      return el.getAttribute('role')
        || (el.tagName === 'A' ? 'link' : '')
        || (el.tagName === 'BUTTON' ? 'button' : '')
        || (el.tagName === 'TEXTAREA' ? 'textbox' : '')
        || (el.tagName === 'SELECT' ? 'combobox' : '')
        || (el.tagName === 'INPUT'
          ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', text: 'textbox', email: 'textbox', search: 'searchbox', password: 'textbox' }[el.type] || 'textbox')
          : '');
    };
    for (const el of document.querySelectorAll(selectors.join(','))) {
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const role = roleOf(el);
      const name = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ');
      const value = 'value' in el && typeof el.value === 'string' ? el.value.trim() : '';
      if (${compact ? "true" : "false"} && !name && !value) continue;
      counter += 1;
      el.setAttribute('data-flmux-ref', 'e' + counter);
      let line = '@e' + counter + ' ' + (role || 'element');
      if (name) line += ' \"' + name.replace(/\"/g, '\\\\\"') + '\"';
      if (value) line += ' value=\"' + value.replace(/\"/g, '\\\\\"') + '\"';
      lines.push(line);
    }
    return lines.length ? lines.join('\\n') : '(no interactive elements found)';
  })()`;
}

function buildResolveTargetExpression(target: string): string {
  return `(() => {
    const raw = (${JSON.stringify(target)} || '').trim();
    if (!raw) return null;
    if (raw.startsWith('@')) return document.querySelector('[data-flmux-ref=\"' + raw.slice(1) + '\"]');
    return document.querySelector(raw);
  })()`;
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
