import { defineCommand } from "citty";
import { callJsonRpc, isRpcEndpointReachable } from "../../client/rpc-client";
import { getPtydEndpoint, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "ptyd", description: "Manage the ptyd daemon" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Show ptyd daemon status" },
      args: { ...sessionArg },
      run: async ({ args }) => {
        const endpoint = await getPtydEndpoint(args.session);
        const reachable = await isRpcEndpointReachable(endpoint);
        if (!reachable) {
          console.log("ptyd: not reachable");
          return;
        }
        output(await callJsonRpc(endpoint, "daemon.status", undefined));
      }
    }),
    list: defineCommand({
      meta: { name: "list", description: "List live terminal runtimes" },
      args: { ...sessionArg },
      run: async ({ args }) => {
        const endpoint = await getPtydEndpoint(args.session);
        output(await callJsonRpc(endpoint, "terminal.list", undefined));
      }
    }),
    stop: defineCommand({
      meta: { name: "stop", description: "Stop the ptyd daemon" },
      args: { ...sessionArg },
      run: async ({ args }) => {
        const endpoint = await getPtydEndpoint(args.session);
        const reachable = await isRpcEndpointReachable(endpoint);
        if (!reachable) {
          console.log("ptyd: not reachable (already stopped?)");
          return;
        }
        await callJsonRpc(endpoint, "daemon.stop", undefined);
        console.log("ptyd: stop requested");
      }
    })
  }
});
