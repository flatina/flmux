import { Stream, type ImplOf } from "bunite-core/rpc";
import { defineExtensionServer } from "@flmux/extension-api";
import { counterCap, type CountChangedEvent } from "./schema";

// Process-singleton state. The counter is a shared resource across every
// session — increment in one tab broadcasts to all sessions.
let count = 0;
const subscribers = new Set<(event: CountChangedEvent) => void>();

function broadcast() {
  for (const emit of subscribers) emit({ count, sourcePaneId: null });
}

export default defineExtensionServer({
  onSession(ctx) {
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
    ctx.serve(counterCap, impl);
  }
});
