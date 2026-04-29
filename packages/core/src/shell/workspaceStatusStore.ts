// Renderer-local KV store scoped to a single workspace. Non-persistent; lives
// alongside `WorkspaceBus` (transient stream) but with retained-value
// semantics so a late subscriber gets the current value without the publisher
// re-emitting. Used by extensions to share runtime status (selection, cursor,
// …) across panes in the same workspace.

export interface WorkspaceStatusStore {
  get<T = unknown>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  /** Invokes `handler` immediately with the current value (or `undefined` if
   *  unset), then on every subsequent change. `Object.is`-equal `set` calls
   *  are skipped. Returns an unsubscribe. */
  subscribe<T = unknown>(key: string, handler: (value: T | undefined) => void): () => void;
  /** Workspace teardown; clears subscribers and values. */
  dispose(): void;
}

export function createWorkspaceStatusStore(): WorkspaceStatusStore {
  const values = new Map<string, unknown>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();
  let disposed = false;

  return {
    get(key) {
      return values.get(key) as never;
    },

    set(key, value) {
      if (disposed) return;
      const had = values.has(key);
      const prev = values.get(key);
      if (had && Object.is(prev, value)) return;
      values.set(key, value);
      const handlers = subscribers.get(key);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(value);
        } catch (error) {
          console.warn("workspace status subscriber failed", { key, error });
        }
      }
    },

    subscribe(key, handler) {
      if (disposed) return () => {};
      const wrapped = handler as (value: unknown) => void;
      let handlers = subscribers.get(key);
      if (!handlers) {
        handlers = new Set();
        subscribers.set(key, handlers);
      }
      handlers.add(wrapped);
      try {
        wrapped(values.get(key));
      } catch (error) {
        console.warn("workspace status subscriber failed", { key, error });
      }
      return () => {
        const set = subscribers.get(key);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) subscribers.delete(key);
      };
    },

    dispose() {
      disposed = true;
      subscribers.clear();
      values.clear();
    }
  };
}
