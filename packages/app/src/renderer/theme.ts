/**
 * Theme mode signal for extensions that can't consume `--fl-*` CSS tokens
 * directly (canvas, WebGL, wasm renderers). Extensions read
 * `document.documentElement.dataset.theme` on mount and listen to the
 * `flmux-theme-change` event for swaps; they map the mode to their own
 * library's theme API (xterm `theme`, CodeMirror Compartment, chart
 * library presets).
 *
 * User preference (`light` / `dark` / `system`) persists in localStorage;
 * `system` follows `prefers-color-scheme`.
 */
export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "flmux.theme";

export function setupTheme(): void {
  const root = document.documentElement;
  const mq = window.matchMedia(DARK_QUERY);

  applyPreference(root, loadPreference());

  mq.addEventListener("change", () => {
    if (root.dataset.theme) return;
    dispatchChange(resolveMode(root, mq));
  });
}

export function getThemePreference(): ThemePreference {
  return loadPreference();
}

export function setThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  const mq = window.matchMedia(DARK_QUERY);
  const before = resolveMode(root, mq);
  persistPreference(preference);
  applyPreference(root, preference);
  const after = resolveMode(root, mq);
  if (before !== after) dispatchChange(after);
}

function applyPreference(root: HTMLElement, preference: ThemePreference): void {
  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
  const mode = resolveMode(root, window.matchMedia(DARK_QUERY));
  // Keep `color-scheme` in sync so the UA paints form controls / scrollbars
  // in the matching palette.
  root.style.colorScheme = mode;
}

function resolveMode(root: HTMLElement, mq: MediaQueryList): ThemeMode {
  const explicit = root.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return mq.matches ? "dark" : "light";
}

function dispatchChange(mode: ThemeMode): void {
  document.dispatchEvent(new CustomEvent("flmux-theme-change", { detail: { mode } }));
}

function loadPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    // localStorage may be unavailable (private mode, sandboxed); fall through.
  }
  return "system";
}

function persistPreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // Silently ignore; preference won't persist across reloads.
  }
}
