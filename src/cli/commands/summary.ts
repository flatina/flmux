import { defineCommand } from "citty";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "summary", description: "Show workspace summary" },
  args: { ...sessionArg },
  run: async ({ args }) => {
    const client = await getClient(args.session);
    output(await client.call("app.summary", undefined));
  }
});
