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
   *  are skipped. Returns an unsubscribe.
   *
   *  Re-entrant `set` from inside a handler is allowed but discouraged: the
   *  inner emit runs synchronously to completion before the outer iteration
   *  resumes, so subscribers added during the inner emit see the inner value
   *  twice and the original outer subscribers will see whichever value is
   *  current when their slot in the iteration is reached. The handler list
   *  is snapshotted, so set/unsubscribe during emit don't corrupt iteration.
   *
   *  After `dispose`, `subscribe` is a no-op and the handler is never called. */
  subscribe<T = unknown>(key: string, handler: (value: T | undefined) => void): () => void;
  /** Workspace teardown; clears subscribers and values. After dispose, `set`
   *  is silently dropped and `subscribe` returns a no-op unsubscribe. */
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
      // Snapshot — handlers may unsubscribe / re-subscribe / set during emit.
      for (const handler of [...handlers]) {
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
