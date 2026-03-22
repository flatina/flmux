import { defineCommand } from "citty";
import { getClient, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "quit", description: "Quit the running flmux app (and ptyd if configured)" },
  args: { ...sessionArg },
  run: async ({ args }) => {
    const client = await getClient(args.session);
    try {
      await client.call("app.quit", undefined);
    } catch {
      // expected — app closes the connection as it exits
    }
    console.log("app: quit requested");
  }
});
