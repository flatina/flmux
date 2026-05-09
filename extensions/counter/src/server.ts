import { defineBunRpc } from "bunite-core";
import { defineExtensionServer } from "@flmux/extension-api";
import type { CounterSchema } from "./schema";

// Module-level state — survives the flmux process lifetime, shared across
// every client. RPC binding happens once per client in `onClientConnected`;
// pane creation is decoupled from RPC handshake.
let count = 0;

type CounterServerRpc = ReturnType<typeof defineBunRpc<CounterSchema>>;
const clientRpcs = new Map<string, CounterServerRpc>();

function broadcast() {
  for (const rpc of clientRpcs.values()) {
    rpc.sendProxy["count.changed"]({ count, sourcePaneId: null });
  }
}

export default defineExtensionServer({
  async onClientConnected(clientId, ctx) {
    const rpc = defineBunRpc<CounterSchema>({
      handlers: {
        requests: {
          getCount: () => ({ count }),
          increment: ({ delta }) => {
            count += typeof delta === "number" ? Math.trunc(delta) : 1;
            broadcast();
            return { count };
          },
          reset: () => {
            count = 0;
            broadcast();
            return { count };
          }
        }
      }
    });
    await ctx.channel().bindTo(rpc);
    clientRpcs.set(clientId, rpc);
    // Push the current value so the renderer skips the initial getCount() round-trip.
    rpc.sendProxy["count.changed"]({ count, sourcePaneId: null });
    return {
      dispose() {
        clientRpcs.delete(clientId);
        rpc.dispose();
      }
    };
  }
});
