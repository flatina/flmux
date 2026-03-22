import { defineCommand } from "citty";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "explorer", description: "Open an explorer pane" },
  args: {
    ...sessionArg,
    path: { type: "positional", description: "Root directory path", required: false },
    title: { type: "string", description: "Pane title" }
  },
  run: async ({ args }) => {
    const client = await getClient(args.session);
    const rootPath = args.path || process.cwd();
    output(
      await client.call("pane.open", {
        leaf: { kind: "explorer", title: args.title, rootPath }
      })
    );
  }
});
