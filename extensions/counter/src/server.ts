import { defineBunRpc } from "bunite-core";
import { defineExtensionServer } from "@flmux/extension-api";
import type { CounterSchema } from "./schema";

// Module-level state — survives the flmux process lifetime and is shared
// across every (paneId × attachmentId) rpc instance. This is what makes the
// "app-scope" half of the counter pane app-scope.
let count = 0;

type Peer = { broadcast: (sourcePaneId: string | null) => void };
const peers = new Set<Peer>();

function notifyAll(sourcePaneId: string | null) {
  for (const peer of peers) peer.broadcast(sourcePaneId);
}

export default defineExtensionServer({
  async onPaneConnected(paneId, _attachmentId, ctx) {
    const rpc = defineBunRpc<CounterSchema>({
      handlers: {
        requests: {
          getCount: () => ({ count }),
          increment: ({ delta }) => {
            count += typeof delta === "number" ? Math.trunc(delta) : 1;
            notifyAll(paneId);
            return { count };
          },
          reset: () => {
            count = 0;
            notifyAll(paneId);
            return { count };
          }
        }
      }
    });
    // Wait for HELLO so the `peer.broadcast(null)` below reaches the pane
    // instead of racing handler registration on the renderer side.
    await ctx.rpcChannel.bindTo(rpc);

    const peer: Peer = {
      broadcast: (sourcePaneId) => {
        rpc.sendProxy["count.changed"]({ count, sourcePaneId });
      }
    };
    peers.add(peer);

    // Push the current value on connect so the renderer skips the initial
    // `getCount()` round-trip.
    peer.broadcast(null);

    return {
      dispose() {
        peers.delete(peer);
        rpc.dispose();
      }
    };
  }
});
