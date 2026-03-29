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

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
