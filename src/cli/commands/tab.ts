import { defineCommand } from "citty";
import { asTabId } from "../../shared/ids";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "tab", description: "Manage workspace tabs" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List all tabs" },
      args: { ...sessionArg },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(await client.call("tab.list", undefined));
      }
    }),
    open: defineCommand({
      meta: { name: "open", description: "Open a new layoutable tab" },
      args: {
        ...sessionArg,
        title: { type: "string", description: "Tab title" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(
          await client.call("tab.open", {
            layoutMode: "layoutable",
            title: args.title
          })
        );
      }
    }),
    focus: defineCommand({
      meta: { name: "focus", description: "Focus a tab" },
      args: {
        ...sessionArg,
        id: { type: "positional", description: "Tab ID", required: true }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(await client.call("tab.focus", { tabId: asTabId(args.id) }));
      }
    }),
    close: defineCommand({
      meta: { name: "close", description: "Close a tab" },
      args: {
        ...sessionArg,
        id: { type: "positional", description: "Tab ID", required: true }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(await client.call("tab.close", { tabId: asTabId(args.id) }));
      }
    })
  }
});
