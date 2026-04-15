import type { WorkspaceBusEvent as CoreWorkspaceBusEvent } from "@flmux/core/shell";

export type WorkspaceBusEvent<T = unknown> = CoreWorkspaceBusEvent<T>;

export interface WorkspaceBusClient {
  publish(topic: string, payload?: unknown): Promise<{
    ok: true;
    value: {
      ok: true;
      published: WorkspaceBusEvent;
    };
  }>;
  subscribe<T = unknown>(topic: string, handler: (event: WorkspaceBusEvent<T>) => void): () => void;
}
