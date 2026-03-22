import { defineCommand } from "citty";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "browser", description: "Browser automation" },
  subCommands: {
    targets: defineCommand({
      meta: { name: "targets", description: "List CDP browser targets" },
      args: { ...sessionArg },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(await client.call("browser.targets", undefined));
      }
    })
  }
});
