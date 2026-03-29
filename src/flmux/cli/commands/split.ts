import { defineCommand } from "citty";
import type { PaneSplitDirection } from "../../../types/pane";
import { asPaneId } from "../../../lib/ids";
import { isTerminalRenderer } from "../../model/pane-params";
import { getClient, output, sessionArg } from "./_utils";

const SPLIT_DIRECTIONS = ["left", "right", "above", "below"] as const;

function isSplitDirection(value: string): value is PaneSplitDirection {
  return (SPLIT_DIRECTIONS as readonly string[]).includes(value);
}

export default defineCommand({
  meta: { name: "split", description: "Split a pane with a new terminal" },
  args: {
    ...sessionArg,
    pane: { type: "string", description: "Target pane ID" },
    direction: {
      type: "string",
      description: "Split direction: left, right, above, below",
      default: "right"
    },
    cwd: { type: "string", description: "Working directory" },
    shell: { type: "string", description: "Shell path" },
    renderer: { type: "string", description: "Terminal renderer: xterm, ghostty" },
    title: { type: "string", description: "Pane title" },
    cmd: { type: "string", description: "Command to run after terminal init hooks" }
  },
  run: async ({ args }) => {
    const client = await getClient(args.session);

    let paneId: string | undefined = args.pane;
    if (!paneId && process.env.FLMUX_PANE_ID) {
      paneId = process.env.FLMUX_PANE_ID;
    }
    if (!paneId) {
      const summary = await client.call("app.summary", undefined);
      paneId = summary.activePaneId ?? undefined;
    }

    if (!paneId) {
      throw new Error("No target pane available. Pass --pane or focus a pane in the app first.");
    }

    if (!isSplitDirection(args.direction)) {
      throw new Error(`Invalid split direction: ${args.direction}`);
    }

    const rendererArg = args.renderer;
    if (rendererArg && !isTerminalRenderer(rendererArg)) {
      throw new Error(`Invalid terminal renderer: ${rendererArg}`);
    }

    const result = await client.call("pane.split", {
      paneId: asPaneId(paneId),
      direction: args.direction as PaneSplitDirection,
      leaf: {
        kind: "terminal",
        title: args.title,
        cwd: args.cwd ?? (process.env.FLMUX_APP_IPC ? process.cwd() : undefined),
        shell: args.shell ?? undefined,
        renderer: isTerminalRenderer(rendererArg) ? rendererArg : undefined,
        startupCommands: args.cmd?.trim() ? [args.cmd] : undefined
      }
    });

    output(result);
  }
});
