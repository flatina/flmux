import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { ShellModelAPI } from "@flmux/core/shell/types";

interface TextEditorPaneRendererDependencies {
  shellModel: ShellModelAPI;
  textEditorViewFactory?: TextEditorPaneViewFactory;
}

type TextEditorPaneParams = {
  path?: string;
};

interface FsReadResult {
  content: string;
  truncated: boolean;
}

export interface TextEditorPaneView {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  focus(): void;
  destroy(): void;
}

export type TextEditorPaneViewFactory = (options: { state: EditorState; parent: HTMLElement }) => TextEditorPaneView;

const MAX_TEXT_EDITOR_READ_BYTES = 5 * 1024 * 1024;
const STYLESHEET_ID = "flmux-text-editor-pane-styles";

const TEXT_EDITOR_CSS = `
.text-editor-panel {
  height: 100%;
  min-height: 0;
}
.flmux-text-editor {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--fl-foreground, #e6eefc);
  background: var(--fl-editor-background, #08101c);
}
.flmux-text-editor__banner {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-bottom: 1px solid var(--fl-border, rgba(255, 255, 255, 0.12));
  color: var(--fl-warning-foreground, #ffd68a);
  background: var(--fl-warning-background, rgba(255, 186, 73, 0.12));
  font: 12px / 1.35 system-ui, sans-serif;
}
.flmux-text-editor__body {
  flex: 1 1 auto;
  min-height: 0;
}
.flmux-text-editor__body .cm-editor {
  height: 100%;
}
.flmux-text-editor__placeholder {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  color: var(--fl-description-foreground, #97a9c8);
  background: var(--fl-editor-background, #08101c);
  font: 12px / 1.45 system-ui, sans-serif;
}
.flmux-text-editor__placeholder--error {
  color: var(--fl-error-foreground, #ff9d9d);
}
.flmux-text-editor__placeholder-title {
  font-weight: 600;
}
.flmux-text-editor__placeholder-detail {
  color: var(--fl-description-foreground, #97a9c8);
}
`;

const THEME_FROM_VARS = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--fl-foreground, #e6eefc)",
    backgroundColor: "var(--fl-editor-background, #08101c)"
  },
  ".cm-scroller": {
    fontFamily: "var(--fl-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace)",
    fontSize: "12px",
    lineHeight: "1.55"
  },
  ".cm-gutters": {
    color: "var(--fl-description-foreground, #97a9c8)",
    backgroundColor: "var(--fl-side-background, rgba(255, 255, 255, 0.03))",
    borderRight: "1px solid var(--fl-border, rgba(255, 255, 255, 0.12))"
  },
  ".cm-line": {
    padding: "0 8px"
  }
});

export class TextEditorPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private paneId = "";
  private path = "";
  private loadToken = 0;
  private view?: TextEditorPaneView;
  private banner?: HTMLElement;
  private body?: HTMLElement;
  private disposed = false;
  private readonly createTextEditorView: TextEditorPaneViewFactory;
  private readonly themeCompartment = new Compartment();
  private readonly onThemeChange = () => {
    this.view?.dispatch({
      effects: this.themeCompartment.reconfigure(activeThemeExtension())
    });
  };

  constructor(private readonly deps: TextEditorPaneRendererDependencies) {
    this.element.className = "text-editor-panel";
    this.createTextEditorView = deps.textEditorViewFactory ?? ((options) => new EditorView(options));
    document.addEventListener("flmux-theme-change", this.onThemeChange);
  }

  init(params: GroupPanelPartInitParameters) {
    this.disposed = false;
    this.paneId = params.api.id;
    const input = (params.params ?? {}) as TextEditorPaneParams;
    this.mount(optionalStringParam(input.path) ?? "");
  }

  update(event: PanelUpdateEvent<TextEditorPaneParams>) {
    const nextPath = optionalStringParam(event.params?.path) ?? "";
    if (nextPath === this.path) return;
    this.mount(nextPath);
  }

  focus() {
    this.view?.focus();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;
    document.removeEventListener("flmux-theme-change", this.onThemeChange);
    this.destroyView();
    this.element.replaceChildren();
    this.banner = undefined;
    this.body = undefined;
  }

  private mount(path: string) {
    ensureStylesheet(STYLESHEET_ID, TEXT_EDITOR_CSS);
    this.path = path;
    this.loadToken += 1;
    const token = this.loadToken;
    this.destroyView();
    this.element.replaceChildren();

    if (!path) {
      this.renderPlaceholder("Text Editor", "No file selected.");
      return;
    }

    this.renderPlaceholder("Loading…", path, "loading");
    void this.loadFile(path, token);
  }

  private async loadFile(path: string, token: number) {
    try {
      const result = await this.deps.shellModel.pathCall(
        "/fs/read",
        { path, maxBytes: MAX_TEXT_EDITOR_READ_BYTES },
        { sourcePaneId: this.paneId }
      );
      if (this.disposed || token !== this.loadToken) return;
      if (!result.ok) {
        this.renderError(result.error, result.code);
        return;
      }
      const read = parseReadResult(result.value);
      if (!read) {
        this.renderError("Invalid /fs/read response");
        return;
      }
      this.renderEditor(path, read.content);
      this.renderTruncatedBanner(read);
    } catch (error) {
      if (this.disposed || token !== this.loadToken) return;
      this.renderError(errorMessage(error));
    }
  }

  private renderEditor(path: string, content: string) {
    this.destroyView();

    const frame = document.createElement("div");
    frame.className = "flmux-text-editor";

    this.banner = document.createElement("div");
    this.banner.className = "flmux-text-editor__banner";
    this.banner.hidden = true;

    this.body = document.createElement("div");
    this.body.className = "flmux-text-editor__body";
    frame.append(this.banner, this.body);
    this.element.replaceChildren(frame);

    this.view = this.createTextEditorView({
      state: EditorState.create({
        doc: content,
        extensions: textEditorExtensions(path, this.themeCompartment)
      }),
      parent: this.body
    });
  }

  private renderTruncatedBanner(read: FsReadResult) {
    if (!this.banner) return;
    if (!read.truncated) {
      this.banner.hidden = true;
      this.banner.textContent = "";
      return;
    }
    this.banner.hidden = false;
    this.banner.textContent = `Truncated - showing first ~${utf8ByteLength(read.content)} bytes`;
  }

  private renderError(message: string, code?: string) {
    this.destroyView();
    this.element.replaceChildren();
    this.renderPlaceholder("Could not open file", code ? `${code}: ${message}` : message, "error");
  }

  private renderPlaceholder(title: string, detail: string, tone: "muted" | "loading" | "error" = "muted") {
    this.banner = undefined;
    this.body = undefined;

    const placeholder = document.createElement("div");
    placeholder.className = [
      "flmux-text-editor__placeholder",
      tone === "error" ? "flmux-text-editor__placeholder--error" : ""
    ]
      .filter(Boolean)
      .join(" ");
    placeholder.dataset.role =
      tone === "error" ? "text-editor-error" : tone === "loading" ? "text-editor-loading" : "text-editor-placeholder";

    const titleEl = document.createElement("div");
    titleEl.className = "flmux-text-editor__placeholder-title";
    titleEl.textContent = title;

    const detailEl = document.createElement("div");
    detailEl.className = "flmux-text-editor__placeholder-detail";
    detailEl.textContent = detail;

    placeholder.replaceChildren(titleEl, detailEl);
    this.element.replaceChildren(placeholder);
  }

  private destroyView() {
    this.view?.destroy();
    this.view = undefined;
  }
}

function textEditorExtensions(path: string, themeCompartment: Compartment): Extension[] {
  const language = languageForPath(path);
  return [
    basicSetup,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    themeCompartment.of(activeThemeExtension()),
    THEME_FROM_VARS,
    ...(language ? [language] : [])
  ];
}

function isDarkTheme(): boolean {
  const explicit = globalThis.document?.documentElement?.dataset?.theme;
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return globalThis.window?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function activeThemeExtension(): Extension {
  return isDarkTheme() ? oneDark : [];
}

function languageForPath(path: string): Extension | null {
  switch (extensionFromPath(path)) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return javascript({ jsx: true, typescript: true });
    case ".md":
    case ".markdown":
      return markdown();
    case ".json":
      return json();
    case ".html":
    case ".htm":
      return html();
    case ".css":
      return css();
    case ".py":
      return python();
    default:
      return null;
  }
}

function extensionFromPath(path: string): string {
  const basename = path.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

function ensureStylesheet(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseReadResult(value: unknown): FsReadResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { content?: unknown; truncated?: unknown };
  return typeof candidate.content === "string" && typeof candidate.truncated === "boolean"
    ? { content: candidate.content, truncated: candidate.truncated }
    : null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
