import { call, defineCap, stream } from "bunite-core/rpc";

export type CountChangedEvent = { count: number; sourcePaneId: string | null };

export const counterCap = defineCap("sample.counter", {
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  reset: call<void, { count: number }>(),
  /** Server-pushed stream — each consumer (one per renderer) gets every
   * update after open. Late-mounted panes call `getCount` for the current
   * value, then consume `changed()` for live updates. */
  changed: stream<void, CountChangedEvent>()
});
