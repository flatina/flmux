import { defineCommand } from "citty";
import { callJsonRpc, isRpcEndpointReachable } from "../rpc-client";
import { getPtydEndpoint, output } from "./_utils";

export default defineCommand({
  meta: { name: "ptyd", description: "Manage the ptyd daemon" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Show ptyd daemon status" },
      run: async () => {
        const endpoint = getPtydEndpoint();
        const reachable = await isRpcEndpointReachable(endpoint);
        if (!reachable) {
          console.log("ptyd: not reachable");
          return;
        }
        output(await callJsonRpc(endpoint, "system.identify", undefined));
      }
    }),
    list: defineCommand({
      meta: { name: "list", description: "List live terminal runtimes" },
      run: async () => {
        const endpoint = getPtydEndpoint();
        output(await callJsonRpc(endpoint, "terminal.list", undefined));
      }
    }),
    stop: defineCommand({
      meta: { name: "stop", description: "Stop the ptyd daemon" },
      run: async () => {
        const endpoint = getPtydEndpoint();
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
