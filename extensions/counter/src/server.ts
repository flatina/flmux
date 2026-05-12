import { defineBunRpc } from "bunite-core";
import { defineExtensionServer } from "@flmux/extension-api";
import type { CounterSchema } from "./schema";

// rpc binding is per-client; `count` is shared module state.
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
    return {
      dispose() {
        clientRpcs.delete(clientId);
        rpc.dispose();
      }
    };
  }
});
