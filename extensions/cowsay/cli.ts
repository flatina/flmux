import { commonArgs, createFlmuxClient, defineCommand, printJson, toFlmuxCliFlags } from "@flmux/extension-api/cli";

export default defineCommand({
  meta: {
    name: "cowsay",
    description: "Open a cowsay pane"
  },
  args: {
    ...commonArgs,
    title: {
      type: "positional",
      description: "Title for the new pane (quote to include spaces)",
      required: false
    }
  },
  async run({ args }) {
    const client = await createFlmuxClient(toFlmuxCliFlags(args));
    const title = args.title?.trim();
    const result = await client.call("/panes/new", {
      kind: "cowsay",
      place: "right",
      ...(title ? { title } : {})
    });
    printJson(result);
  }
});
