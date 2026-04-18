import type { SequencedShellCoreEvent } from "@flmux/core/shell";

// Main starts forwarding only after flmux.client.register, which the renderer
// issues after FlmuxWorkbench subscribes — so there is no pre-subscribe window
// to buffer at the bus level. Workbench owns the bootstrap-buffer discipline.
const subscribers = new Set<(event: SequencedShellCoreEvent) => void>();

export function pushShellCoreEvent(event: SequencedShellCoreEvent) {
  for (const handler of subscribers) {
    handler(event);
  }
}

export function subscribeShellCoreEvents(
  handler: (event: SequencedShellCoreEvent) => void
): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
