import type { WorkspaceBusEvent as CoreWorkspaceBusEvent } from "@flmux/core/shell";

export type WorkspaceBusEvent<T = unknown> = CoreWorkspaceBusEvent<T>;

/**
 * Transient in-workspace pub/sub for extension panes.
 *
 * A3b scope: bus instances are **workspace-local within the current client**.
 * A publish from one pane reaches every subscriber attached to the same
 * workspace on the same client (desktop renderer, or a single browser attach).
 * Cross-client broadcast — a CLI/HTTP publisher reaching a renderer
 * subscriber, or one browser publish reaching another browser — is not wired
 * in A3b and arrives in Phase B via the server broadcast channel.
 */
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
