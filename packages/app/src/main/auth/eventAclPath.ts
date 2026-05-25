import type { SequencedShellCoreEvent } from "@flmux/core/shell";

/**
 * Map a shellCore event to the path the user would need `allow_paths.read`
 * on to observe it. The broadcast-forwarder ACL check (B3) applies this
 * mapping so a user with a narrowed read-scope doesn't see events for
 * paths they can't query via HTTP.
 *
 * Returning `null` means the event is "structural" (pre-state, topology
 * not tied to a specific readable path) — always allowed.
 */
export function eventToReadPath(event: SequencedShellCoreEvent): string | null {
  switch (event.topic) {
    case "app.titleChanged":
      return "/status/app/title";
    case "workspace.added":
    case "workspace.removed":
    case "workspace.titleChanged":
      return `/status/workspaces/${event.payload.id}`;
    case "workspace.activeChanged":
      // Slot-scoped — observing the active-change of your own client
      // requires read on /status/clients/{yourId}/currentWorkspace.
      return event.targetClientId ? `/status/clients/${event.targetClientId}/currentWorkspace` : null;
    case "pane.added":
    case "pane.removed":
    case "pane.titleChanged":
    case "pane.paramsChanged":
      return `/status/panes/${event.payload.paneId}`;
    case "pane.activeChanged":
      return event.targetClientId ? `/status/clients/${event.targetClientId}/currentWorkspace` : null;
    default: {
      // New topic = compile error: forces explicit mapping, else a forgotten
      // topic would broadcast as structural (silent read-ACL fail-open).
      const _exhaustive: never = event;
      void _exhaustive;
      return "/__unmapped_event__"; // unreachable; fails closed if hit
    }
  }
}
