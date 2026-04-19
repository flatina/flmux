import {
  isBrowserPaneStateRecord,
  type BrowserPaneStateRecord,
  type PaneSpec,
  type PaneWorkspaceContext
} from "./panes";
import { normalizeBrowserUrl } from "./shellCore";

/**
 * Shared browser-kind pane spec — lifecycle, subtree, and persistence.
 * Composes browser URLs from `workspace.appOrigin` rather than closing over
 * any caller state, so web and desktop can share the same factory.
 */
export function createBrowserPaneSpec(): PaneSpec<BrowserPaneStateRecord> {
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
        getStateSnapshot: ({ record }) =>
          isBrowserPaneStateRecord(record) ? { url: record.url } : undefined,
        canSetStatePath: ({ record }, relativePath) =>
          isBrowserPaneStateRecord(record) &&
          relativePath.length === 1 &&
          relativePath[0] === "url",
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
        getStatusSnapshot: ({ record }) =>
          isBrowserPaneStateRecord(record) ? { url: record.url } : undefined
      }
    ],
    persistence: {
      normalizeRestoredParams: ({ workspace, params }) => ({
        url: resolveBrowserUrl(workspace, optionalStringParam(params?.url) ?? workspace.defaultBrowserPath)
      }),
      serializeParams: ({ record, workspace }) =>
        isBrowserPaneStateRecord(record)
          ? { url: stripAppOrigin(record.url, workspace.appOrigin) }
          : undefined
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
