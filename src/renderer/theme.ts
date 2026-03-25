import type { ITheme } from "@xterm/xterm";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import type { UiTheme } from "../shared/ui-settings";

export type ResolvedTheme = "dark" | "light";

let currentTheme: UiTheme = "dark";
let resolved: ResolvedTheme = "dark";
const listeners: Array<(theme: ResolvedTheme) => void> = [];

function resolve(theme: UiTheme): ResolvedTheme {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyResolved(next: ResolvedTheme): void {
  if (next === resolved) return;
  resolved = next;
  document.documentElement.dataset.theme = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // error boundary — don't crash other listeners
    }
  }
}

/** Call once at startup before any DOM rendering. */
export function initTheme(theme: UiTheme): void {
  currentTheme = theme;
  resolved = resolve(theme);
  document.documentElement.dataset.theme = resolved;

  // Listen for OS color scheme changes (relevant when theme === "system")
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme === "system") {
      applyResolved(resolve("system"));
    }
  });
}

/** Change theme and notify all listeners. */
export function setTheme(theme: UiTheme): void {
  currentTheme = theme;
  applyResolved(resolve(theme));
}

export function getTheme(): UiTheme {
  return currentTheme;
}

/** Subscribe to resolved theme changes. Returns unsubscribe function. */
export function onThemeChange(fn: (theme: ResolvedTheme) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

const DARK_TERMINAL_THEME: ITheme = {
  background: "#0b1016",
  foreground: "#e8edf2",
  cursor: "#ffad5a",
  cursorAccent: "#0b1016",
  selectionBackground: "rgba(255, 173, 90, 0.25)"
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#fafbfc",
  foreground: "#24292e",
  cursor: "#d4820f",
  cursorAccent: "#fafbfc",
  selectionBackground: "rgba(212, 130, 15, 0.18)"
};

export function getTerminalTheme(): ITheme {
  return resolved === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

/** Returns CodeMirror theme extension(s) for the current resolved theme. */
export function getEditorThemeExtension(): Extension {
  return resolved === "dark" ? oneDark : [];
}
