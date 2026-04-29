/**
 * Workspace-scoped retained KV store for transient status sharing between
 * panes in the same workspace. Non-persistent (does not survive reload).
 *
 * Differs from `WorkspaceBusClient` in that values are *retained* — a late
 * subscriber receives the current value immediately on `subscribe`, so
 * publishers don't need to re-emit for newcomers.
 *
 * Shape must stay structurally compatible with `WorkspaceStatusStore` in
 * `@flmux/core/shell/workspaceStatusStore` (the host-side implementation).
 */

export interface WorkspaceStatusStoreClient {
  get<T = unknown>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  /** Invokes `handler` immediately with the current value (or `undefined` if
   *  unset), then on every subsequent change. `Object.is`-equal `set` calls
   *  are suppressed. Returns an unsubscribe. */
  subscribe<T = unknown>(key: string, handler: (value: T | undefined) => void): () => void;
}
