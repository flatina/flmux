import { defineBunRpc } from "bunite-core";
import { defineExtensionServer } from "@flmux/extension-api";
import type { CounterSchema } from "./schema";

// Module-level state — survives for the flmux process lifetime and is shared
// across every (paneId × attachmentId) rpc instance. This is the whole point
// of a server entry: one counter, many viewers.
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
    // Wait for the HELLO handshake so any `send` below reaches the pane
    // instead of racing the peer's handler registration.
    await ctx.rpcChannel.bindTo(rpc);

    const peer: Peer = {
      broadcast: (sourcePaneId) => {
        rpc.sendProxy["count.changed"]({ count, sourcePaneId });
      }
    };
    peers.add(peer);

    // Push the current value on mount so the renderer doesn't have to
    // issue its own initial `getCount()` round-trip.
    peer.broadcast(null);

    return {
      dispose() {
        peers.delete(peer);
        rpc.dispose();
      }
    };
  }
});
