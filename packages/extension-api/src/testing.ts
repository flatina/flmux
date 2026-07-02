import type { WorkspaceBusClient, WorkspaceBusEvent } from "./bus";
import type { WorkspaceStatusStoreClient } from "./status";
import type { PaneStateStore } from "./state";
import type {
  ShellClient,
  ShellPathCallResult,
  ShellPathGetResult,
  ShellPathListResult,
  ShellPathSetResult
} from "./shell";
import type { ExtensionPaneContext } from "./pane";

/**
 * Testing utilities for `@flmux/extension-api` consumers. Not bundled by
 * extensions; import from `@flmux/extension-api/testing` (subpath export).
 *
 * Goal: let an extension's own test suite (and adapter libraries that
 * duck-type against flmux shapes) verify behavior without spinning up the
 * full flmux runtime. Every factory returns the same interface shape an
 * extension sees at runtime, so a unit test can hand an
 * `ExtensionPaneContext` to `definition.mount(host, context)` directly.
 */

/**
 * In-memory `WorkspaceBusClient` matching flmux's `createWorkspaceBus`
 * semantics exactly (topic patterns `*` / `prefix.*` / exact; subscriber
 * exceptions isolated; `publish` always resolves `{ok, value:{ok, published}}`).
 *
 * Every client produced by one bus shares subscriptions — call
 * `createTestBus(workspaceId).attachPane(paneId)` twice to get two clients
 * that reach each other. Self-filtering (ignore events where
 * `sourcePaneId === myPaneId`) is the subscriber's responsibility, matching
 * the real bus contract.
 */
export interface TestBus {
  readonly workspaceId: string;
  /** Create a `WorkspaceBusClient` bound to `paneId`; its `publish` stamps
   * `sourcePaneId` automatically. */
  attachPane(paneId: string): WorkspaceBusClient;
  /** Number of live subscriptions (any pane, any topic). Useful for leak checks. */
  subscriberCount(): number;
}

interface BusSubscription {
  topic: string;
  handler: (event: WorkspaceBusEvent) => void;
}

export function createTestBus(workspaceId: string): TestBus {
  const subscriptions = new Set<BusSubscription>();

  return {
    workspaceId,
    subscriberCount: () => subscriptions.size,
    attachPane(paneId: string): WorkspaceBusClient {
      return {
        async publish(topic: string, payload?: unknown) {
          const event: WorkspaceBusEvent = {
            topic,
            workspaceId,
            sourcePaneId: paneId,
            payload: payload ?? null,
            timestamp: Date.now()
          };
          for (const sub of subscriptions) {
            if (!matchesTopic(sub.topic, topic)) continue;
            try {
              sub.handler(event);
            } catch (error) {
              console.warn("test bus subscriber failed", { workspaceId, topic, error });
            }
          }
          return { ok: true as const, value: { ok: true as const, published: event } };
        },
        subscribe<T>(topic: string, handler: (event: WorkspaceBusEvent<T>) => void) {
          const sub: BusSubscription = {
            topic,
            handler: handler as (event: WorkspaceBusEvent) => void
          };
          subscriptions.add(sub);
          return () => {
            subscriptions.delete(sub);
          };
        }
      };
    }
  };
}

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return pattern === topic;
}

/**
 * In-memory `PaneStateStore`. Mirrors what flmux gives an extension pane:
 * mutable params + title, `patchParams` merges shallow. No persistence.
 */
export function createTestPaneStateStore(
  initial: { params?: Record<string, unknown>; title?: string } = {}
): PaneStateStore {
  let params: Record<string, unknown> = { ...(initial.params ?? {}) };
  let title: string | undefined = initial.title;

  return {
    getParams: <T extends Record<string, unknown> = Record<string, unknown>>() => ({ ...params }) as T,
    setParams(nextParams: Record<string, unknown>) {
      params = { ...nextParams };
    },
    patchParams(patch: Record<string, unknown>) {
      params = { ...params, ...patch };
    },
    getTitle: () => title,
    setTitle(next: string) {
      title = next;
    }
  };
}

/**
 * Route table for `createTestShellClient`. Keys are `"<op> <path>"`:
 *   "get /status/app/origin" -> () => "http://127.0.0.1:4000"
 *   "call /panes/new"        -> (args) => ({ paneId: "pane.1" })
 * Handler return value is wrapped as `{ok:true, found:true, value:...}`
 * (get/list) or `{ok:true, value:...}` (set/call). Missing route →
 * `{ok:false, code:"NOT_FOUND"}`.
 */
export type TestShellRoutes = {
  [key: `get ${string}`]: (path: string) => unknown;
  [key: `list ${string}`]: (path: string) => unknown;
  [key: `set ${string}`]: (path: string, value: unknown) => unknown;
  [key: `call ${string}`]: (path: string, args: Record<string, unknown> | undefined) => unknown;
};

export function createTestShellClient(routes: Partial<TestShellRoutes> = {}): ShellClient {
  const notFoundGet = (): ShellPathGetResult => ({ ok: false, code: "NOT_FOUND", error: "no route" });
  const notFoundList = (): ShellPathListResult => ({ ok: false, code: "NOT_FOUND", error: "no route" });
  const notFoundSet = (): ShellPathSetResult => ({ ok: false, code: "NOT_FOUND", error: "no route" });
  const notFoundCall = (): ShellPathCallResult => ({ ok: false, code: "NOT_FOUND", error: "no route" });

  return {
    async get(path: string): Promise<ShellPathGetResult> {
      const handler = routes[`get ${path}` as `get ${string}`] as ((path: string) => unknown) | undefined;
      if (!handler) return notFoundGet();
      return { ok: true, found: true, value: await handler(path) };
    },
    async list(path: string): Promise<ShellPathListResult> {
      const handler = routes[`list ${path}` as `list ${string}`] as ((path: string) => unknown) | undefined;
      if (!handler) return notFoundList();
      const entries = (await handler(path)) as ShellPathListResult extends { entries: infer E } ? E : never;
      return { ok: true, found: true, entries: entries ?? [] };
    },
    async set(path: string, value: unknown): Promise<ShellPathSetResult> {
      const handler = routes[`set ${path}` as `set ${string}`] as
        | ((path: string, value: unknown) => unknown)
        | undefined;
      if (!handler) return notFoundSet();
      return { ok: true, value: await handler(path, value) };
    },
    async call(path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult> {
      const handler = routes[`call ${path}` as `call ${string}`] as
        | ((path: string, args: Record<string, unknown> | undefined) => unknown)
        | undefined;
      if (!handler) return notFoundCall();
      return { ok: true, value: await handler(path, args) };
    }
  };
}

/**
 * Factory for `ExtensionPaneContext`. Every field has a sensible default;
 * override what the test needs. `bus.attachPane(paneId)` runs implicitly
 * when `bus` is a `TestBus` — pass a pre-attached `WorkspaceBusClient` to
 * override.
 */
export interface TestPaneContextOptions {
  paneId?: string;
  workspaceId?: string;
  userId?: string;
  shell?: ShellClient;
  bus?: TestBus | WorkspaceBusClient;
  workspaceStatus?: WorkspaceStatusStoreClient;
  state?: PaneStateStore;
  capturePane?: ExtensionPaneContext["capturePane"];
}

export function createTestPaneContext(options: TestPaneContextOptions = {}): ExtensionPaneContext {
  const paneId = options.paneId ?? "pane.test";
  const workspaceId = options.workspaceId ?? "workspace.test";
  const userId = options.userId ?? "user.test";
  const shell = options.shell ?? createTestShellClient();
  const state = options.state ?? createTestPaneStateStore();
  const bus = resolveBus(options.bus, workspaceId, paneId);
  const workspaceStatus = options.workspaceStatus ?? createTestWorkspaceStatusStore();
  return {
    paneId,
    workspaceId,
    userId,
    shell,
    bus,
    workspaceStatus,
    state,
    setHeaderMenu: () => {},
    capturePane:
      options.capturePane ??
      (() => Promise.reject(new Error("capturePane is not implemented in createTestPaneContext")))
  };
}

/** In-memory `WorkspaceStatusStoreClient` matching flmux's
 *  `createWorkspaceStatusStore` semantics: retained values, immediate replay
 *  on subscribe, `Object.is`-equal sets suppress emit. */
export function createTestWorkspaceStatusStore(): WorkspaceStatusStoreClient {
  const values = new Map<string, unknown>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();

  return {
    get<T = unknown>(key: string) {
      return values.get(key) as T | undefined;
    },
    set<T>(key: string, value: T) {
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
          console.warn("test workspace status subscriber failed", { key, error });
        }
      }
    },
    subscribe<T = unknown>(key: string, handler: (value: T | undefined) => void) {
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
        console.warn("test workspace status subscriber failed", { key, error });
      }
      return () => {
        const set = subscribers.get(key);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) subscribers.delete(key);
      };
    }
  };
}

function resolveBus(
  value: TestBus | WorkspaceBusClient | undefined,
  workspaceId: string,
  paneId: string
): WorkspaceBusClient {
  if (!value) {
    return createTestBus(workspaceId).attachPane(paneId);
  }
  if (isTestBus(value)) {
    return value.attachPane(paneId);
  }
  return value;
}

function isTestBus(value: TestBus | WorkspaceBusClient): value is TestBus {
  return "attachPane" in value && typeof (value as TestBus).attachPane === "function";
}
