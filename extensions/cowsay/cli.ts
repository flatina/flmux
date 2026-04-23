import { defineCommand } from "citty";
import { commonArgs, createFlmuxClient, printJson, toFlmuxCliFlags } from "@flmux/extension-api";

export default defineCommand({
  meta: {
    name: "cowsay",
    description: "Open a cowsay pane"
  },
  args: {
    ...commonArgs,
    title: {
      type: "positional",
      description: "Title for the new pane (multiple words joined)",
      required: false
    }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const client = await createFlmuxClient(flags);
    const title = args._.join(" ").trim();
    const result = await client.call("/panes/new", {
      kind: "cowsay",
      place: "right",
      ...(title ? { title } : {})
    });
    printJson(result);
  }
});
