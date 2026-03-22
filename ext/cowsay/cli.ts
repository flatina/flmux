import type { ExtensionCliCommand } from "../../src/shared/extension-abi";

export const command: ExtensionCliCommand = {
  meta: { name: "cowsay", description: "Open or message a cowsay pane" },
  args: {
    message: { type: "positional", description: "Message text", required: false },
    pane: { type: "string", description: "Target pane ID (sends event instead of opening)" },
    session: { type: "string", description: "Target session ID" }
  },
  run: async ({ args, getClient, output }) => {
    const client = await getClient(args.session as string | undefined);

    if (args.pane) {
      output(
        await client.call("pane.message", {
          paneId: args.pane as string,
          eventType: "cowsay:said",
          data: { text: (args.message as string) || "moo" }
        })
      );
    } else {
      output(
        await client.call("pane.open", {
          leaf: {
            kind: "extension",
            extensionId: "sample.cowsay",
            contributionId: "cowsay"
          }
        })
      );
    }
  }
};
