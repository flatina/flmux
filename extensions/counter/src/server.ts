import { Stream, type ImplOf } from "bunite-core/rpc";
import { defineExtensionServer, type ExtensionConfig } from "@flmux/extension-api";
import { counterCap, type CountChangedEvent } from "./schema";

// Process-singleton state. The counter is a shared resource across every
// session — increment in one tab broadcasts to all sessions.
let count = 0;
const subscribers = new Set<(event: CountChangedEvent) => void>();

// ctx.loadConfig demo: `<dataDir>/counter.toml` (`initial`, `step`) layered
// over defaults; `watch` applies external edits live (click ±1 after changing
// `step` to see it).
type CounterConfig = { initial: number; step: number };
let config: ExtensionConfig<CounterConfig> | null = null;
const step = () => config?.value.step ?? 1;

function broadcast() {
  for (const emit of subscribers) emit({ count, sourcePaneId: null });
}

export default defineExtensionServer({
  async onInit(ctx) {
    config = await ctx.loadConfig<CounterConfig>((b) =>
      b
        .useDefaults({ initial: 0, step: 1 })
        .useTomlFile("counter.toml", { required: false, watch: true })
        .validate((value) => {
          if (!Number.isInteger(value.initial)) {
            throw new Error(`counter.toml: initial must be an integer, got ${String(value.initial)}`);
          }
          if (!Number.isInteger(value.step) || value.step === 0) {
            throw new Error(`counter.toml: step must be a non-zero integer, got ${String(value.step)}`);
          }
        })
    );
    count = config.value.initial;
  },
  onSession(ctx) {
    const impl: ImplOf<typeof counterCap> = {
      getCount: () => ({ count }),
      increment: ({ delta }) => {
        count += step() * (typeof delta === "number" ? Math.trunc(delta) : 1);
        broadcast();
        return { count };
      },
      reset: () => {
        count = config?.value.initial ?? 0;
        broadcast();
        return { count };
      },
      changed: () =>
        Stream.from<CountChangedEvent>((emit, signal) => {
          subscribers.add(emit);
          signal.addEventListener("abort", () => subscribers.delete(emit));
        })
    };
    ctx.serve(counterCap, impl);
  }
});
