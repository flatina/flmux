/**
 * Theme mode signal for extensions that can't consume `--fl-*` CSS tokens
 * directly (canvas, WebGL, wasm renderers). Extensions read
 * `document.documentElement.dataset.theme` on mount and listen to the
 * `flmux-theme-change` event for swaps; they map the mode to their own
 * library's theme API (xterm `theme`, CodeMirror Compartment, chart
 * library presets).
 *
 * Resolution order: `data-theme` attribute if set → `prefers-color-scheme`
 * otherwise. OS preference changes are forwarded only when no explicit
 * override is active.
 */
export type ThemeMode = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function setupTheme(): void {
  const root = document.documentElement;
  const mq = window.matchMedia(DARK_QUERY);

  applyResolvedMode(root, mq);

  mq.addEventListener("change", () => {
    if (root.dataset.theme) return;
    applyResolvedMode(root, mq);
  });
}

/**
 * Set an explicit theme override. Pass `null` to clear the override and
 * fall back to the OS `prefers-color-scheme`. Dispatches
 * `flmux-theme-change` whenever the resolved mode changes.
 */
export function setThemeMode(mode: ThemeMode | null): void {
  const root = document.documentElement;
  const before = resolveMode(root, window.matchMedia(DARK_QUERY));
  if (mode === null) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
  const after = resolveMode(root, window.matchMedia(DARK_QUERY));
  if (before !== after) dispatchChange(after);
}

function applyResolvedMode(root: HTMLElement, mq: MediaQueryList): void {
  const mode = resolveMode(root, mq);
  // Keep `color-scheme` in sync so the UA paints form controls / scrollbars
  // in the matching palette even if the extension renderer styles haven't
  // loaded yet.
  root.style.colorScheme = mode;
  dispatchChange(mode);
}

function resolveMode(root: HTMLElement, mq: MediaQueryList): ThemeMode {
  const explicit = root.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return mq.matches ? "dark" : "light";
}

function dispatchChange(mode: ThemeMode): void {
  document.dispatchEvent(new CustomEvent("flmux-theme-change", { detail: { mode } }));
}
