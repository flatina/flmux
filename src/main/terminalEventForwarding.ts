import type { TerminalRuntimeEvent } from "../shared/terminal";
import type { FlmuxClientRegistry } from "./clientRegistry";

export function forwardTerminalEventToOwnedClient(options: {
  event: TerminalRuntimeEvent;
  paneOwners: Map<string, number>;
  clientRegistry: FlmuxClientRegistry;
}) {
  const { event, paneOwners, clientRegistry } = options;
  const paneId = event.paneId ?? null;
  if (!paneId) {
    return false;
  }

  const viewId = paneOwners.get(paneId);
  if (!viewId) {
    return false;
  }

  const client = clientRegistry.resolveByViewId(viewId);
  if (!client) {
    return false;
  }

  if (event.type === "removed") {
    paneOwners.delete(paneId);
  }

  client.bridge.sendProxy["terminal.event"](event);
  return true;
}
