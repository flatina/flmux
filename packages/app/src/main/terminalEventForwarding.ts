import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import type { ClientRegistry } from "./clientRegistry";

/**
 * Fan out a terminal event to every live subscriber of the pane. Stale
 * viewIds (client disconnected without `releaseView` sweeping) are
 * lazy-cleaned from the Set. On `type: "removed"` the entire Set is
 * dropped — the pane no longer has a runtime to subscribe to.
 */
export function forwardTerminalEventToSubscribers(options: {
  event: TerminalRuntimeEvent;
  paneSubscribers: Map<string, Set<number>>;
  clientRegistry: ClientRegistry;
}): boolean {
  const { event, paneSubscribers, clientRegistry } = options;
  const paneId = event.paneId ?? null;
  if (!paneId) return false;

  const subscribers = paneSubscribers.get(paneId);
  if (!subscribers || subscribers.size === 0) return false;

  if (event.type === "removed") {
    paneSubscribers.delete(paneId);
  }

  let delivered = false;
  for (const viewId of [...subscribers]) {
    const client = clientRegistry.resolveRendererByViewId(viewId);
    if (!client) {
      subscribers.delete(viewId);
      continue;
    }
    client.bridge.sendProxy["terminal.event"](event);
    delivered = true;
  }

  if (subscribers.size === 0 && event.type !== "removed") {
    paneSubscribers.delete(paneId);
  }

  return delivered;
}
