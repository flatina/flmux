import { BrowserPaneRenderer } from "../panes/browserPane";
import { TerminalPaneRenderer } from "../panes/terminalPane";
import {
  type PaneDescriptor,
  type PaneRegistry,
  isBrowserPaneRecord,
  isTerminalPaneRecord
} from "./paneRegistry";

export interface BuiltinPaneDescriptorDependencies {
  installRoot: string;
  requireBrowserUrl(value: string): string;
  resolveTerminalCwd(rootDir: string, inputCwd: string | undefined): string;
  serializeBrowserUrl(url: string): string;
}

export function registerBuiltinPaneDescriptors(
  registry: PaneRegistry,
  deps: BuiltinPaneDescriptorDependencies
) {
  for (const descriptor of createBuiltinPaneDescriptors(deps)) {
    registry.register(descriptor);
  }
}

function createBuiltinPaneDescriptors(
  deps: BuiltinPaneDescriptorDependencies
): PaneDescriptor[] {
  return [
    {
      kind: "browser",
      createRenderer: ({ runtime }) =>
        new BrowserPaneRenderer({
          panelTemplate: runtime.browserPanelTemplate,
          normalizeUrl: runtime.normalizeBrowserUrl,
          onUrlChange: runtime.onBrowserUrlChange
        }),
      lifecycle: {
        createParams: ({ workspace, input }) => ({
          url: deps.requireBrowserUrl(input.url ?? workspace.defaultBrowserPath)
        }),
        getTitle: ({ input, params }) =>
          input.title?.trim() || inferBrowserTitle(optionalStringParam(params?.url) ?? "Browser"),
        createRecord: ({ workspace, params }) => ({
          kind: "browser",
          url: deps.requireBrowserUrl(optionalStringParam(params?.url) ?? workspace.defaultBrowserPath)
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isBrowserPaneRecord(record)
            ? {
                id: paneId,
                kind: "browser",
                title,
                active,
                browser: {
                  url: record.url
                }
              }
            : {
                id: paneId,
                kind: record.kind,
                title,
                active
              }
      },
      subtreeMounts: [
        {
          mountKey: "browser",
          getStateSnapshot: ({ record }) =>
            isBrowserPaneRecord(record)
              ? { url: record.url }
              : undefined,
          canSetStatePath: ({ record }, relativePath) =>
            isBrowserPaneRecord(record) &&
            relativePath.length === 1 &&
            relativePath[0] === "url",
          setState: async ({ record, currentParams, setParams }, relativePath, value) => {
            if (!isBrowserPaneRecord(record)) {
              throw new Error("browser subtree only applies to browser panes");
            }
            if (relativePath.length !== 1 || relativePath[0] !== "url") {
              throw new Error(`Unsupported browser path '${relativePath.join("/")}'`);
            }

            const nextUrl = deps.requireBrowserUrl(requiredString(value, "Pane url"));
            record.url = nextUrl;
            await setParams({
              ...(currentParams ?? {}),
              url: nextUrl
            });
            return { value: nextUrl };
          },
          getStatusSnapshot: ({ record }) =>
            isBrowserPaneRecord(record)
              ? { url: record.url }
              : undefined
        }
      ],
      persistence: {
        normalizeRestoredParams: ({ workspace, params }) => ({
          url: deps.requireBrowserUrl(optionalStringParam(params?.url) ?? workspace.defaultBrowserPath)
        }),
        serializeParams: ({ record }) =>
          isBrowserPaneRecord(record)
            ? { url: deps.serializeBrowserUrl(record.url) }
            : undefined
      }
    },
    {
      kind: "terminal",
      createRenderer: ({ runtime }) =>
        new TerminalPaneRenderer({
          shellModel: runtime.shellModel,
          terminalEvents: runtime.terminalHost,
          onRuntimeStateChange: runtime.onTerminalRuntimeStateChange
        }),
      lifecycle: {
        createParams: ({ input }) => ({
          cwd: deps.resolveTerminalCwd(deps.installRoot, input.cwd),
          autoCreate: input.params?.autoCreate === true
        }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ params }) => ({
          kind: "terminal",
          cwd: deps.resolveTerminalCwd(deps.installRoot, optionalStringParam(params?.cwd)),
          rootKey: null,
          runtimeId: null,
          summary: null
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isTerminalPaneRecord(record)
            ? {
                id: paneId,
                kind: "terminal",
                title,
                active,
                terminal: {
                  attached: record.runtimeId !== null,
                  rootKey: record.rootKey,
                  cwd: record.cwd,
                  runtimeId: record.runtimeId,
                  alive: record.summary?.alive ?? null,
                  commandCount: record.summary?.commandCount ?? null,
                  createdAt: record.summary?.createdAt ?? null,
                  updatedAt: record.summary?.updatedAt ?? null
                }
              }
            : {
                id: paneId,
                kind: record.kind,
                title,
                active
              }
      },
      subtreeMounts: [
        {
          mountKey: "terminal",
          getStateSnapshot: ({ record }) =>
            isTerminalPaneRecord(record)
              ? { cwd: record.cwd }
              : undefined,
          getStatusSnapshot: ({ record }) =>
            isTerminalPaneRecord(record)
              ? {
                  attached: record.runtimeId !== null,
                  rootKey: record.rootKey,
                  cwd: record.cwd,
                  runtimeId: record.runtimeId,
                  alive: record.summary?.alive ?? null,
                  commandCount: record.summary?.commandCount ?? null,
                  createdAt: record.summary?.createdAt ?? null,
                  updatedAt: record.summary?.updatedAt ?? null
                }
              : undefined
        }
      ],
      persistence: {
        normalizeRestoredParams: ({ params }) => ({
          cwd: deps.resolveTerminalCwd(deps.installRoot, optionalStringParam(params?.cwd))
        }),
        serializeParams: ({ record }) =>
          isTerminalPaneRecord(record)
            ? { cwd: record.cwd }
            : undefined
      }
    }
  ];
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
    return lastPath ? capitalizeSegment(lastPath) : parsed.host || "Browser";
  } catch {
    return "Browser";
  }
}

function capitalizeSegment(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
