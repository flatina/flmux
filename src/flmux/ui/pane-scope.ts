import { parseViewKey } from "../../lib/view-key";
import type { PaneId, TabId, TerminalRuntimeId } from "../../lib/ids";
import type { TerminalRuntimeSummary } from "../../types/terminal";
import type {
  BrowserPaneParams,
  EditorPaneParams,
  ExplorerPaneParams,
  PaneParams,
  TerminalPaneParams,
  ViewPaneParams
} from "../model/pane-params";
import { PropertyOwnerBase, PropertyUnavailableError, type PropertyChangeCallback } from "../props/property";
import { prop } from "../props/decorators";
import { browserTitleFromUrl, normalizeUrl, readBrowserUrl, readEditorFilePath } from "./helpers";
import type { TabRenderer } from "./tabs/tab-renderer";

export interface PaneScopeHost {
  queueSave(): void;
  getPaneParams(): PaneParams | null;
  updatePaneParams(patch: Partial<PaneParams>, options?: { statePatch?: Record<string, unknown> }): void;
  getTerminalRuntime(runtimeId: TerminalRuntimeId): TerminalRuntimeSummary | null;
  publishSimpleWorkspaceTitleChange(previousValue: unknown): void;
}

export class PaneScope extends PropertyOwnerBase {
  private _activatedAt: number = performance.now();
  private _openerPaneId: PaneId | null = null;
  private browserWebviewId: number | null = null;
  private browserCdpReady = false;
  private browserCdpTargetId: string | null = null;
  private browserCdpWebSocketDebuggerUrl: string | null = null;

  constructor(
    private readonly host: PaneScopeHost,
    readonly tabId: TabId,
    readonly paneId: PaneId,
    private readonly renderer: TabRenderer,
    private readonly publishChange: PropertyChangeCallback
  ) {
    super();
    this.finalizeProperties();
  }

  protected override onPropertyChanged(key: string, value: unknown, previousValue: unknown): void {
    super.onPropertyChanged(key, value, previousValue);
    this.publishChange({ scope: "pane", targetId: this.paneId, key, value, previousValue, timestamp: Date.now() });
  }

  protected override afterWrite(key: string, previousValue: unknown): void {
    if (key === "title" && !this.renderer.isLayoutable) {
      this.host.publishSimpleWorkspaceTitleChange(previousValue);
    }
  }

  @prop({ type: "string", description: "Pane title" })
  getTitle(): string {
    const title = this.renderer.getPaneTitle(String(this.paneId));
    if (title === null) throw new PropertyUnavailableError(`pane not found: ${this.paneId}`);
    return title;
  }

  @prop()
  setTitle(value: unknown): void {
    const nextTitle = String(value ?? "").trim();
    if (!nextTitle) return;
    this.renderer.setPaneTitle(String(this.paneId), nextTitle);
    this.host.queueSave();
  }

  @prop({ description: "Pane kind" })
  getKind(): string {
    return this.requirePaneParams().kind;
  }

  markActivated(): void {
    this._activatedAt = performance.now();
  }

  get ageMs(): number {
    return performance.now() - this._activatedAt;
  }

  // --- terminal ---

  @prop("terminal.runtimeId", { type: "string", nullable: true, readonly: true, description: "Terminal runtime id" })
  getTerminalRuntimeId(): string | null {
    return this.requireTerminalPane().runtimeId ?? null;
  }

  @prop("terminal.cwd", { type: "string", nullable: true, readonly: true, description: "Terminal startup cwd" })
  getTerminalCwd(): string | null {
    return this.requireTerminalPane().cwd ?? null;
  }

  @prop("terminal.shell", { type: "string", nullable: true, readonly: true, description: "Terminal startup shell" })
  getTerminalShell(): string | null {
    return this.requireTerminalPane().shell ?? null;
  }

  @prop("terminal.renderer", { type: "string", readonly: true, description: "Terminal renderer" })
  getTerminalRenderer(): string {
    return this.requireTerminalPane().renderer ?? "xterm";
  }

  @prop("terminal.cols", { type: "number", nullable: true, readonly: true, description: "Live terminal cols" })
  getTerminalCols(): number | null {
    const pane = this.requireTerminalPane();
    return pane.runtimeId ? (this.host.getTerminalRuntime(pane.runtimeId)?.cols ?? null) : null;
  }

  @prop("terminal.rows", { type: "number", nullable: true, readonly: true, description: "Live terminal rows" })
  getTerminalRows(): number | null {
    const pane = this.requireTerminalPane();
    return pane.runtimeId ? (this.host.getTerminalRuntime(pane.runtimeId)?.rows ?? null) : null;
  }

  // --- browser ---

  @prop("browser.url", { type: "string", nullable: true, description: "Browser URL" })
  getBrowserUrl(): string | null {
    return readBrowserUrl(this.requireBrowserPane()) ?? null;
  }

  @prop("browser.url")
  setBrowserUrl(value: unknown): void {
    const nextUrl = normalizeUrl(String(value ?? ""));
    if (this.getBrowserUrl() === nextUrl) return;
    const previousTitle = this.getTitle();
    this.host.updatePaneParams({ url: nextUrl }, { statePatch: { url: nextUrl } });
    this.renderer.setPaneTitle(String(this.paneId), browserTitleFromUrl(nextUrl));
    this.publishMirroredTitleChanges(previousTitle);
  }

  @prop("browser.openerPaneId", { type: "string", nullable: true, readonly: true, description: "Pane that opened this browser" })
  getBrowserOpenerPaneId(): string | null {
    this.requireBrowserPane();
    return this._openerPaneId;
  }

  @prop("browser.openerPaneId", { readonly: true })
  setBrowserOpenerPaneId(value: unknown): void {
    this.requireBrowserPane();
    this._openerPaneId = typeof value === "string" && value ? (value as PaneId) : null;
  }

  @prop("browser.adapter", { type: "string", readonly: true, options: ["electrobun-native", "web-iframe"], description: "Browser adapter" })
  getBrowserAdapter(): string {
    return this.requireBrowserPane().adapter ?? "electrobun-native";
  }

  @prop("browser.webviewId", { type: "number", nullable: true, readonly: true, description: "Native webview id" })
  getBrowserWebviewId(): number | null {
    this.requireBrowserPane();
    return this.browserWebviewId;
  }

  @prop("browser.webviewId", { readonly: true })
  setBrowserWebviewId(value: unknown): void {
    this.requireBrowserPane();
    this.browserWebviewId = typeof value === "number" ? value : null;
  }

  @prop("browser.cdp.ready", { type: "boolean", readonly: true, description: "Whether browser automation is ready" })
  getBrowserCdpReady(): boolean {
    this.requireBrowserPane();
    return this.browserCdpReady;
  }

  @prop("browser.cdp.ready", { readonly: true })
  setBrowserCdpReady(value: unknown): void {
    this.requireBrowserPane();
    this.browserCdpReady = value === true;
  }

  @prop("browser.cdp.targetId", { type: "string", nullable: true, readonly: true, description: "CDP target id" })
  getBrowserCdpTargetId(): string | null {
    this.requireBrowserPane();
    return this.browserCdpTargetId;
  }

  @prop("browser.cdp.targetId", { readonly: true })
  setBrowserCdpTargetId(value: unknown): void {
    this.requireBrowserPane();
    this.browserCdpTargetId = normalizeNullableString(value);
  }

  @prop("browser.cdp.webSocketDebuggerUrl", { type: "string", nullable: true, readonly: true, description: "CDP websocket URL" })
  getBrowserCdpWebSocketDebuggerUrl(): string | null {
    this.requireBrowserPane();
    return this.browserCdpWebSocketDebuggerUrl;
  }

  @prop("browser.cdp.webSocketDebuggerUrl", { readonly: true })
  setBrowserCdpWebSocketDebuggerUrl(value: unknown): void {
    this.requireBrowserPane();
    this.browserCdpWebSocketDebuggerUrl = normalizeNullableString(value);
  }

  // --- editor ---

  @prop("editor.filePath", { type: "string", nullable: true, description: "Open file path" })
  getEditorFilePath(): string | null {
    return readEditorFilePath(this.requireEditorPane());
  }

  @prop("editor.filePath")
  setEditorFilePath(value: unknown): void {
    const nextFilePath = normalizeNullableString(value);
    if (this.getEditorFilePath() === nextFilePath) return;
    const previousTitle = this.getTitle();
    this.host.updatePaneParams({ filePath: nextFilePath }, { statePatch: { filePath: nextFilePath } });
    this.renderer.setPaneTitle(String(this.paneId), getEditorPaneTitle(nextFilePath));
    this.publishMirroredTitleChanges(previousTitle);
  }

  @prop("editor.language", { type: "string", nullable: true, description: "Language override" })
  getEditorLanguage(): string | null {
    return this.requireEditorPane().language ?? null;
  }

  @prop("editor.language")
  setEditorLanguage(value: unknown): void {
    this.host.updatePaneParams({ language: normalizeNullableString(value) });
  }

  // --- explorer ---

  @prop("explorer.rootPath", { type: "string", description: "Explorer root path" })
  getExplorerRootPath(): string {
    const pane = this.requireExplorerPane();
    if (!pane.rootPath) throw new PropertyUnavailableError(`explorer rootPath missing: ${this.paneId}`);
    return pane.rootPath;
  }

  @prop("explorer.rootPath")
  setExplorerRootPath(value: unknown): void {
    const nextRootPath = String(value ?? "").trim();
    if (!nextRootPath) throw new Error("explorer.rootPath requires a non-empty string");
    this.host.updatePaneParams({ rootPath: nextRootPath });
  }

  @prop("explorer.mode", { type: "string", readonly: true, options: ["filetree", "dirtree", "filelist"], description: "Explorer mode" })
  getExplorerMode(): string {
    const pane = this.requireExplorerPane();
    if (!pane.mode) throw new PropertyUnavailableError(`explorer mode missing: ${this.paneId}`);
    return pane.mode;
  }

  // --- view ---

  @prop("view.viewKey", { type: "string", nullable: true, readonly: true, description: "Extension view key" })
  getViewViewKey(): string | null {
    return this.requireViewPane().viewKey ?? null;
  }

  @prop("view.extensionId", { type: "string", nullable: true, readonly: true, description: "Owning extension id" })
  getViewExtensionId(): string | null {
    return parseViewKey(this.requireViewPane().viewKey)?.extensionId ?? null;
  }

  @prop("view.viewId", { type: "string", nullable: true, readonly: true, description: "Extension-local view id" })
  getViewId(): string | null {
    return parseViewKey(this.requireViewPane().viewKey)?.viewId ?? null;
  }

  // --- lifecycle ---

  notifyTerminalRuntimeChanged(previous: TerminalRuntimeSummary | null, next: TerminalRuntimeSummary | null): void {
    if ((previous?.cols ?? null) !== (next?.cols ?? null)) {
      this.notify("terminal.cols", previous?.cols ?? null);
    }
    if ((previous?.rows ?? null) !== (next?.rows ?? null)) {
      this.notify("terminal.rows", previous?.rows ?? null);
    }
  }

  setState(nextState: Record<string, unknown>): void {
    this.host.updatePaneParams({}, { statePatch: nextState });
  }

  tracksTerminalRuntime(runtimeId: TerminalRuntimeId): boolean {
    const pane = this.host.getPaneParams();
    return pane?.kind === "terminal" && pane.runtimeId === runtimeId;
  }

  dispose(): void {}

  // --- private ---

  private requirePaneParams(): PaneParams {
    const pane = this.host.getPaneParams();
    if (!pane) throw new PropertyUnavailableError(`pane not found: ${this.paneId}`);
    return pane;
  }

  private requireTerminalPane(): TerminalPaneParams {
    const pane = this.requirePaneParams();
    if (pane.kind !== "terminal") throw new PropertyUnavailableError(`pane is not terminal: ${this.paneId}`);
    return pane;
  }

  private requireBrowserPane(): BrowserPaneParams {
    const pane = this.requirePaneParams();
    if (pane.kind !== "browser") throw new PropertyUnavailableError(`pane is not browser: ${this.paneId}`);
    return pane;
  }

  private requireEditorPane(): EditorPaneParams {
    const pane = this.requirePaneParams();
    if (pane.kind !== "editor") throw new PropertyUnavailableError(`pane is not editor: ${this.paneId}`);
    return pane;
  }

  private requireExplorerPane(): ExplorerPaneParams {
    const pane = this.requirePaneParams();
    if (pane.kind !== "explorer") throw new PropertyUnavailableError(`pane is not explorer: ${this.paneId}`);
    return pane;
  }

  private requireViewPane(): ViewPaneParams {
    const pane = this.requirePaneParams();
    if (pane.kind !== "view") throw new PropertyUnavailableError(`pane is not view: ${this.paneId}`);
    return pane;
  }

  private publishMirroredTitleChanges(previousTitle: string): void {
    const nextTitle = this.getTitle();
    if (Object.is(previousTitle, nextTitle)) return;
    this.notify("title", previousTitle);
    if (!this.renderer.isLayoutable) {
      this.host.publishSimpleWorkspaceTitleChange(previousTitle);
    }
  }
}

export function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEditorPaneTitle(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const normalized = filePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "Untitled";
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}
