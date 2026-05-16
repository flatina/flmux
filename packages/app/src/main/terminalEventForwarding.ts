import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

/**
 * Fan out a terminal event to every live emitter for the pane. Each emitter
 * is a `shell.terminalEvents({paneId})` stream consumer. On `type: "removed"`
 * the pane's emitter set is dropped — the pane no longer has a runtime.
 *
 * Stream consumers register themselves via `shellImpl.terminalEvents` setup;
 * stream abort removes the emitter from the Set, no separate teardown path
 * needed.
 */
export function forwardTerminalEventToSubscribers(options: {
  event: TerminalRuntimeEvent;
  paneEmitters: Map<string, Set<(event: TerminalRuntimeEvent) => void>>;
}): boolean {
  const { event, paneEmitters } = options;
  const paneId = event.paneId ?? null;
  if (!paneId) return false;

  const emitters = paneEmitters.get(paneId);
  if (!emitters || emitters.size === 0) return false;

  if (event.type === "removed") paneEmitters.delete(paneId);

  let delivered = false;
  for (const emit of [...emitters]) {
    try {
      emit(event);
      delivered = true;
    } catch {
      /* stream consumer threw — drop, bunite stream layer handles cleanup on next abort */
    }
  }

  return delivered;
}
