import { asPaneId, type PaneId } from "../shared/ids";

export function resolveBrowserPaneId(value?: string): PaneId {
  const raw = value?.trim() || process.env.FLMUX_BROWSER?.trim();
  if (!raw) {
    throw new Error(
      [
        "No browser pane selected.",
        "Set FLMUX_BROWSER first:",
        "  export FLMUX_BROWSER=$(flmux browser new https://example.com)",
        "",
        "Or pass a pane explicitly:",
        "  flweb snapshot --pane browser.1a2b3c4d"
      ].join("\n")
    );
  }

  return asPaneId(raw);
}

export function resolveSenderPaneId(value?: string): PaneId | undefined {
  const raw = value?.trim() || process.env.FLMUX_PANE_ID?.trim();
  return raw ? asPaneId(raw) : undefined;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printPaneIds(paneIds: string[]): void {
  if (paneIds.length === 0) {
    return;
  }

  for (const paneId of paneIds) {
    console.log(paneId);
  }
}
