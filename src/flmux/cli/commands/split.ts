import { defineCommand } from "citty";
import { getClient, sessionArg } from "./_utils";
import { executeOpen } from "./open";

export default defineCommand({
  meta: { name: "split", description: "Split a pane with a new terminal" },
  args: {
    ...sessionArg,
    pane: { type: "string", description: "Target pane ID" },
    direction: { type: "positional", description: "Split direction: left, right, above, below", required: false },
    cwd: { type: "string", description: "Working directory" },
    shell: { type: "string", description: "Shell path" },
    renderer: { type: "string", description: "Terminal renderer: xterm, ghostty" },
    title: { type: "string", description: "Pane title" },
    cmd: { type: "string", description: "Command to run after terminal init hooks" }
  },
  run: async ({ args }) => {
    const client = await getClient(args.session);
    await executeOpen(client, "terminal", args.direction ?? "right", args.pane, args);
  }
});
