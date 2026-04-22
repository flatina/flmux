/**
 * Transient in-workspace pub/sub for extension panes.
 *
 * Bus instances are **workspace-local within the current client**. A publish
 * from one pane reaches every subscriber attached to the same workspace on the
 * same client (desktop renderer, or a single browser attach). Cross-client
 * broadcast — a CLI/HTTP publisher reaching a renderer subscriber, or one
 * browser publish reaching another browser — is not wired yet.
 *
 * Shape must stay structurally compatible with `WorkspaceBusEvent` /
 * `WorkspaceBus` in `@flmux/core/shell/types` (the host-side implementation).
 */

export interface WorkspaceBusEvent<T = unknown> {
  topic: string;
  workspaceId: string;
  sourcePaneId: string;
  payload: T;
  timestamp: number;
}

export interface WorkspaceBusClient {
  publish(
    topic: string,
    payload?: unknown
  ): Promise<{
    ok: true;
    value: {
      ok: true;
      published: WorkspaceBusEvent;
    };
  }>;
  subscribe<T = unknown>(topic: string, handler: (event: WorkspaceBusEvent<T>) => void): () => void;
}
