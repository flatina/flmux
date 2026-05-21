import {
  isBrowserPaneStateRecord,
  type BrowserPaneStateRecord,
  type PaneSpec,
  type PaneWorkspaceContext
} from "./panes";
import { normalizeBrowserUrl } from "./shellCore";

/** Primitive ops directly forwarded to bunite SurfaceCap.
 * App-owned superset (extended by Stage E+F + agent layer in `paneSpecs.ts`)
 * is passed via `callableOps`; core stays unaware of the full op universe. */
export const PRIMITIVE_OPS = [
  "goBack",
  "reload",
  "evaluate",
  "click",
  "type",
  "press",
  "scroll",
  "screenshot",
  "capabilities"
] as const;

/** Widened to `string` — actual whitelisting lives in app-owned
 * `callableOps` Set. Keeps core free of drift when new ops land. */
export type BrowserPaneCallable = string;

/**
 * App-injected gateway from `path.call`/`path.get(/status)` to the live
 * bunite surface. Spec stays unaware of bunite RPC; controller resolves
 * paneId → surfaceId and dispatches.
 */
export interface BrowserPaneController {
  call(paneId: string, op: BrowserPaneCallable, args: Record<string, unknown>): Promise<{ value: unknown }>;
  getStatus(paneId: string): Record<string, unknown> | undefined;
}

export interface BrowserPaneSpecOptions {
  controller?: BrowserPaneController;
  /** Allowed op names for `/panes/{id}/browser/{op}` path calls. Default =
   * `PRIMITIVE_OPS`. App-side composition (agent surface) extends this with
   * its own ops without touching core. */
  callableOps?: ReadonlySet<string>;
}

/**
 * Shared browser-kind pane spec — lifecycle, subtree, and persistence.
 * Composes browser URLs from `workspace.appOrigin` rather than closing over
 * any caller state, so web and desktop can share the same factory. Pass
 * `controller` to expose automation calls (`/panes/{id}/browser/{op}`) and
 * runtime-derived status. Omit for read-only restoration use (tests).
 */
export function createBrowserPaneSpec(options: BrowserPaneSpecOptions = {}): PaneSpec<BrowserPaneStateRecord> {
  const { controller } = options;
  const callableOps = options.callableOps ?? new Set<string>(PRIMITIVE_OPS);
  return {
    kind: "browser",
    lifecycle: {
      createParams: ({ workspace, input }) => ({
        url: resolveBrowserUrl(workspace, input.url ?? workspace.defaultBrowserPath)
      }),
      getTitle: ({ input, params }) =>
        input.title?.trim() || inferBrowserTitle(optionalStringParam(params?.url) ?? "Browser"),
      createRecord: ({ workspace, params }) => ({
        kind: "browser",
        url: resolveBrowserUrl(workspace, optionalStringParam(params?.url) ?? workspace.defaultBrowserPath)
      }),
      createSnapshot: ({ paneId, title, record }) => ({
        id: paneId,
        kind: "browser",
        title,
        browser: { url: record.url }
      })
    },
    subtreeMounts: [
      {
        mountKey: "browser",
        getStateSnapshot: ({ record }) => (isBrowserPaneStateRecord(record) ? { url: record.url } : undefined),
        canSetStatePath: ({ record }, relativePath) =>
          isBrowserPaneStateRecord(record) && relativePath.length === 1 && relativePath[0] === "url",
        setState: async ({ record, currentParams, setParams, workspace }, relativePath, value) => {
          if (!isBrowserPaneStateRecord(record)) {
            throw new Error("browser subtree only applies to browser panes");
          }
          if (relativePath.length !== 1 || relativePath[0] !== "url") {
            throw new Error(`Unsupported browser path '${relativePath.join("/")}'`);
          }
          const nextUrl = resolveBrowserUrl(workspace, requiredString(value, "Pane url"));
          record.url = nextUrl;
          await setParams({ ...(currentParams ?? {}), url: nextUrl });
          return { value: nextUrl };
        },
        canCallStatePath: ({ record }, relativePath) =>
          isBrowserPaneStateRecord(record) && relativePath.length === 1 && callableOps.has(relativePath[0]),
        callState: async ({ paneId, record }, relativePath, args) => {
          if (!isBrowserPaneStateRecord(record)) {
            throw new Error("browser subtree only applies to browser panes");
          }
          if (!controller) {
            throw new Error("browser pane controller not wired — automation calls unavailable");
          }
          return controller.call(paneId, relativePath[0], args);
        },
        getStatusSnapshot: ({ paneId, record }) => {
          if (!isBrowserPaneStateRecord(record)) return undefined;
          const live = controller?.getStatus(paneId);
          return { url: record.url, ...(live ?? {}) };
        }
      }
    ],
    persistence: {
      normalizeRestoredParams: ({ workspace, params }) => ({
        url: resolveBrowserUrl(workspace, optionalStringParam(params?.url) ?? workspace.defaultBrowserPath)
      }),
      serializeParams: ({ record, workspace }) =>
        isBrowserPaneStateRecord(record) ? { url: stripAppOrigin(record.url, workspace.appOrigin) } : undefined
    }
  };
}

function resolveBrowserUrl(workspace: PaneWorkspaceContext, value: string): string {
  return normalizeBrowserUrl("", workspace.appOrigin, value, workspace.defaultBrowserPath);
}

/** Strip the app origin when it matches so saved snapshots stay portable across port changes. */
function stripAppOrigin(url: string, appOrigin: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === appOrigin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {}
  return url;
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }
  return trimmed;
}

function inferBrowserTitle(url: string) {
  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop();
    return lastPath ? lastPath.charAt(0).toUpperCase() + lastPath.slice(1) : parsed.host || "Browser";
  } catch {
    return "Browser";
  }
}
