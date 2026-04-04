import type { AppRpcClient } from "../flmux/client/rpc-client";
import { resolveAppRpcClient } from "../flmux/client/rpc-client";
import { asPaneId, type PaneId } from "../lib/ids";

export const sessionArg = {
  session: {
    type: "string" as const,
    description: "Target session ID"
  }
};

export async function getClient(sessionId?: string): Promise<AppRpcClient> {
  const { client } = await resolveAppRpcClient(sessionId);
  return client;
}

export async function resolveBrowserPaneId(client: AppRpcClient, value?: string): Promise<PaneId> {
  const raw = value?.trim() || process.env.FLMUX_BROWSER?.trim();
  if (raw) {
    return asPaneId(raw);
  }

  const summary = await client.call("app.summary", undefined);
  const browserPanes = summary.panes.filter((p) => p.kind === "browser");
  if (browserPanes.length === 0) {
    throw new Error(
      [
        "No browser pane found.",
        "Create one first:",
        "  flmux browser new https://example.com"
      ].join("\n")
    );
  }

  // Active pane is a browser → use it
  if (summary.activePaneId) {
    const active = browserPanes.find((p) => p.paneId === summary.activePaneId);
    if (active) return active.paneId;
  }

  // Most recently activated browser pane (lowest ageMs)
  const sorted = browserPanes.filter((p) => typeof p.ageMs === "number").sort((a, b) => (a.ageMs ?? 0) - (b.ageMs ?? 0));
  if (sorted.length > 0) return sorted[0]!.paneId;

  // Only one browser pane
  if (browserPanes.length === 1) return browserPanes[0]!.paneId;

  throw new Error(
    [
      `${browserPanes.length} browser panes found, none active.`,
      "Set FLMUX_BROWSER or pass --pane:",
      "  flweb snapshot --pane browser.1a2b3c4d"
    ].join("\n")
  );
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
