import { BrowserPaneRenderer } from "../panes/browserPane";
import { TerminalPaneRenderer } from "../panes/terminalPane";
import {
  type PaneDescriptor,
  type PaneRegistry,
  isBrowserPaneRecord,
  isTerminalPaneRecord
} from "./paneRegistry";

export interface BuiltinPaneDescriptorDependencies {
  fixtureUrl(fixture: string): string;
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
          url: deps.requireBrowserUrl(input.url ?? deps.fixtureUrl(workspace.defaultFixture))
        }),
        getTitle: ({ input, params }) =>
          input.title?.trim() || inferBrowserTitle(optionalStringParam(params?.url) ?? "Browser"),
        createRecord: ({ workspace, panel, params }) => ({
          kind: "browser",
          panel,
          url: deps.requireBrowserUrl(optionalStringParam(params?.url) ?? deps.fixtureUrl(workspace.defaultFixture))
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
      persistence: {
        normalizeRestoredParams: ({ workspace, params }) => ({
          url: deps.requireBrowserUrl(optionalStringParam(params?.url) ?? deps.fixtureUrl(workspace.defaultFixture))
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
        createParams: ({ workspace, input }) => ({
          cwd: deps.resolveTerminalCwd(workspace.rootDir, input.cwd),
          rootDir: workspace.rootDir
        }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ workspace, panel, params }) => ({
          kind: "terminal",
          panel,
          cwd: deps.resolveTerminalCwd(workspace.rootDir, optionalStringParam(params?.cwd)),
          rootDir: workspace.rootDir,
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
      persistence: {
        normalizeRestoredParams: ({ workspace, params }) => ({
          cwd: deps.resolveTerminalCwd(workspace.rootDir, optionalStringParam(params?.cwd)),
          rootDir: workspace.rootDir
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

function inferBrowserTitle(url: string) {
  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop();
    return lastPath ? fixtureLabel(lastPath) : parsed.host || "Browser";
  } catch {
    return "Browser";
  }
}

function fixtureLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
