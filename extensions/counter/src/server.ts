import { Stream, type ImplOf } from "bunite-core/rpc";
import { defineExtensionServer } from "@flmux/extension-api";
import { counterCap, type CountChangedEvent } from "./schema";

// Module-level: state is shared across every connection / client.
let count = 0;
const subscribers = new Set<(event: CountChangedEvent) => void>();

function broadcast() {
  for (const emit of subscribers) emit({ count, sourcePaneId: null });
}

const impl: ImplOf<typeof counterCap> = {
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
  },
  changed: () => Stream.from<CountChangedEvent>((emit, signal) => {
    subscribers.add(emit);
    signal.addEventListener("abort", () => subscribers.delete(emit));
  })
};

export default defineExtensionServer({
  serve(ctx) {
    const handle = ctx.connection.serve(counterCap, impl);
    return { dispose() { ctx.connection.unserve(handle); } };
  }
});
