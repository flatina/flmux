// Renderer-side view prefs; the event lets open editor panes reflect a change live.

export interface EditorOptions {
  wordWrap: boolean;
  lineNumbers: boolean;
  tabSize: 2 | 4 | 8;
}

export const EDITOR_OPTIONS_EVENT = "flmux-editor-options-change";

const STORAGE_KEY = "flmux.editorOptions";
const DEFAULTS: EditorOptions = { wordWrap: true, lineNumbers: true, tabSize: 2 };

export function loadEditorOptions(): EditorOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<EditorOptions>;
    return {
      wordWrap: typeof raw.wordWrap === "boolean" ? raw.wordWrap : DEFAULTS.wordWrap,
      lineNumbers: typeof raw.lineNumbers === "boolean" ? raw.lineNumbers : DEFAULTS.lineNumbers,
      tabSize: raw.tabSize === 4 || raw.tabSize === 8 ? raw.tabSize : DEFAULTS.tabSize
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveEditorOptions(options: EditorOptions): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  document.dispatchEvent(new CustomEvent(EDITOR_OPTIONS_EVENT));
}
