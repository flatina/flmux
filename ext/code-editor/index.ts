import { css as langCss } from "@codemirror/lang-css";
import { html as langHtml } from "@codemirror/lang-html";
import { javascript as langJs } from "@codemirror/lang-javascript";
import { json as langJson } from "@codemirror/lang-json";
import { markdown as langMd } from "@codemirror/lang-markdown";
import { Compartment } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import { defineView, type HeaderAction } from "flmux-sdk";

type EditorParams = {
  filePath: string | null;
  language: string | null;
};

type EditorState = {
  filePath?: string | null;
};

export default defineView<EditorParams, EditorState>({
  createInstance(context) {
    let params = normalizeParams(context.params);
    let currentFilePath = context.state?.filePath ?? params.filePath;
    let dirty = false;
    let view: EditorView | null = null;
    let host: HTMLElement | null = null;
    let themeUnsub: (() => void) | null = null;
    const themeCompartment = new Compartment();
    const languageCompartment = new Compartment();
    let statusLang: HTMLSpanElement | null = null;
    let statusLines: HTMLSpanElement | null = null;
    let statusEol: HTMLSpanElement | null = null;

    return {
      async mount(nextHost) {
        host = nextHost;

        const shell = document.createElement("div");
        shell.className = "editor-pane";

        const editorHost = document.createElement("div");
        editorHost.className = "editor-host";

        const statusBar = document.createElement("div");
        statusBar.className = "editor-statusbar";

        statusLines = document.createElement("span");
        statusLines.textContent = "1 line";
        statusEol = document.createElement("span");
        statusEol.textContent = "LF";
        const statusEnc = document.createElement("span");
        statusEnc.textContent = "UTF-8";
        statusLang = document.createElement("span");
        statusLang.textContent = resolveLanguageName(currentFilePath, params.language);

        statusBar.append(statusLines, statusEol, statusEnc, statusLang);
        shell.append(editorHost, statusBar);
        host.replaceChildren(shell);

        view = new EditorView({
          doc: "",
          extensions: [
            basicSetup,
            themeCompartment.of(getEditorThemeExtension(context.getResolvedTheme())),
            languageCompartment.of(resolveLanguageExtension(currentFilePath, params.language) ?? []),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                dirty = true;
                syncUi();
                updateStatus(update.state.doc);
              }
            }),
            EditorView.domEventHandlers({
              keydown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "s") {
                  event.preventDefault();
                  void saveFile();
                }
              }
            })
          ],
          parent: editorHost
        });

        themeUnsub = context.onThemeChange((theme) => {
          view?.dispatch({ effects: themeCompartment.reconfigure(getEditorThemeExtension(theme)) });
        });

        syncUi();
        refreshHeaderActions();
        if (currentFilePath) {
          await loadFile(currentFilePath);
        }

        function updateStatus(doc: { lines: number; toString: () => string }): void {
          if (statusLines) {
            statusLines.textContent = `${doc.lines} line${doc.lines !== 1 ? "s" : ""}`;
          }
          if (statusEol) {
            statusEol.textContent = doc.toString().includes("\r\n") ? "CRLF" : "LF";
          }
        }

        async function loadFile(filePath: string): Promise<void> {
          if (!view) {
            return;
          }
          let content = "";
          try {
            content = await context.fs.readFile(filePath);
          } catch (error) {
            content = `[error loading file: ${error instanceof Error ? error.message : String(error)}]`;
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content }
          });
          dirty = false;
          updateStatus(view.state.doc);
          syncUi();
        }

        async function saveFile(): Promise<void> {
          if (!view) {
            return;
          }
          if (!currentFilePath) {
            await saveFileAs();
            return;
          }

          if (!dirty) {
            return;
          }

          try {
            await context.fs.writeFile(currentFilePath, view.state.doc.toString());
            dirty = false;
            syncUi();
          } catch {
            // best effort
          }
        }

        async function saveFileAs(): Promise<void> {
          if (!view) {
            return;
          }
          const suggestedPath = currentFilePath ?? "untitled.txt";
          const nextPath = prompt("Save As...", suggestedPath)?.trim();
          if (!nextPath) {
            return;
          }

          try {
            await context.fs.writeFile(nextPath, view.state.doc.toString());
          } catch (error) {
            alert(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }

          currentFilePath = nextPath;
          context.setState({ filePath: nextPath });
          dirty = false;
          if (statusLang) {
            statusLang.textContent = resolveLanguageName(currentFilePath, params.language);
          }
          syncUi();
          refreshHeaderActions();
        }

        function refreshHeaderActions(): void {
          const actions: HeaderAction[] = [
            {
              id: "editor-save",
              icon: "Save",
              tooltip: "Save",
              onClick: () => void saveFile()
            },
            {
              id: "editor-save-as",
              icon: "Save As...",
              tooltip: "Save As...",
              onClick: () => void saveFileAs()
            }
          ];
          context.setHeaderActions(actions);
        }

        function syncUi(): void {
          context.curPane.title = getEditorTabTitle(currentFilePath, dirty);
        }
      },
      async update(nextParams) {
        if (!view) {
          return;
        }
        const next = normalizeParams(nextParams);
        const fileChanged = next.filePath !== params.filePath;
        const languageChanged = next.language !== params.language;
        params = next;

        if (fileChanged) {
          currentFilePath = params.filePath;
        }

        if (languageChanged) {
          view.dispatch({
            effects: languageCompartment.reconfigure(resolveLanguageExtension(currentFilePath, params.language) ?? [])
          });
        }

        statusLang && (statusLang.textContent = resolveLanguageName(currentFilePath, params.language));

        if (fileChanged && currentFilePath) {
          let content = "";
          try {
            content = await context.fs.readFile(currentFilePath);
          } catch (error) {
            content = `[error loading file: ${error instanceof Error ? error.message : String(error)}]`;
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content }
          });
          dirty = false;
          statusLines && (statusLines.textContent = `${view.state.doc.lines} line${view.state.doc.lines !== 1 ? "s" : ""}`);
          statusEol && (statusEol.textContent = view.state.doc.toString().includes("\r\n") ? "CRLF" : "LF");
        }

        context.curPane.title = getEditorTabTitle(currentFilePath, dirty);
      },
      dispose() {
        themeUnsub?.();
        context.setHeaderActions([]);
        view?.destroy();
        host?.replaceChildren();
        view = null;
        host = null;
      }
    };
  }
});

function normalizeParams(value: unknown): EditorParams {
  const raw = value as Partial<EditorParams> | null | undefined;
  return {
    filePath: typeof raw?.filePath === "string" ? raw.filePath : null,
    language: typeof raw?.language === "string" ? raw.language : null
  };
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
    case "tsx":
    case "jsx":
    case "typescript":
      return "TypeScript";
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
  const base = filePath ? fileNameFromPath(filePath) : "Untitled";
  return dirty ? `${base} *` : base;
}

function getEditorThemeExtension(theme: "dark" | "light") {
  return theme === "dark" ? oneDark : [];
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "Untitled";
  }

  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}
