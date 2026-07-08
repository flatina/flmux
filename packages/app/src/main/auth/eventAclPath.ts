import type { SequencedShellCoreEvent } from "@flmux/core/shell";

/** Path a user needs `allow_paths.read` on to observe this event (broadcast ACL);
 * `null` = structural (always allowed). Tagging a payload topic `null` passes silently. */
export function eventToReadPath(event: SequencedShellCoreEvent): string | null {
  switch (event.topic) {
    case "app.titleChanged":
      return "/status/app/title";
    case "workspace.added":
    case "workspace.removed":
    case "workspace.titleChanged":
      return `/status/workspaces/${event.payload.id}`;
    case "workspace.activeChanged":
      // slot-scoped: your own active-change → read on your currentWorkspace.
      return event.targetClientId ? `/status/clients/${event.targetClientId}/currentWorkspace` : null;
    case "pane.added":
    case "pane.removed":
    case "pane.titleChanged":
    case "pane.paramsChanged":
      return `/status/panes/${event.payload.paneId}`;
    case "pane.activeChanged":
      return event.targetClientId ? `/status/clients/${event.targetClientId}/currentWorkspace` : null;
    default: {
      // never: a new topic must map explicitly (compile error otherwise).
      const _exhaustive: never = event;
      void _exhaustive;
      return "/__unmapped_event__"; // fail-closed: matches no narrowed glob
    }
  }
}
