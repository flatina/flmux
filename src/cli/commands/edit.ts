import { defineCommand } from "citty";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "edit", description: "Open a file in the editor" },
  args: {
    ...sessionArg,
    file: { type: "positional", description: "File path to open", required: true },
    title: { type: "string", description: "Pane title" }
  },
  run: async ({ args }) => {
    const client = await getClient(args.session);
    const filePath = args.file.startsWith("/") || args.file.includes(":")
      ? args.file
      : `${process.cwd()}/${args.file}`;
    output(
      await client.call("pane.open", {
        leaf: { kind: "editor", title: args.title, filePath }
      })
    );
  }
});
