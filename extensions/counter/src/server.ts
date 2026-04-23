import { defineBunRPC } from "bunite-core";
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
  onPaneConnected(paneId, _attachmentId, ctx) {
    const rpc = defineBunRPC<CounterSchema>({
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
    rpc.setTransport(ctx.transport);

    const peer: Peer = {
      broadcast: (sourcePaneId) => {
        rpc.sendProxy["count.changed"]({ count, sourcePaneId });
      }
    };
    peers.add(peer);

    // Push the current value on mount so the pane never has to race its own
    // initial `getCount()` against the attachment-bind window in web mode.
    peer.broadcast(null);

    return {
      dispose() {
        peers.delete(peer);
        rpc.dispose();
      }
    };
  }
});
