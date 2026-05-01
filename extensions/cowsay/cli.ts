import { commonArgs, createFlmuxClient, defineExtensionCommand, printJson, toFlmuxCliFlags } from "@flmux/extension-api/cli";

export default defineExtensionCommand({
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
  async run(parsedArgs, ctx) {
    console.info(`[cowsay] dataDir = ${ctx.dataDir}`);
    const client = await createFlmuxClient(toFlmuxCliFlags(parsedArgs));
    const title = parsedArgs.title?.trim();
    const result = await client.call("/panes/new", {
      kind: "cowsay",
      place: "right",
      ...(title ? { title } : {})
    });
    printJson(result);
  }
});
