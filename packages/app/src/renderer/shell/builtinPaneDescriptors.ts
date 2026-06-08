import { PLACEHOLDER_PANE_KIND, createBrowserPaneSpec } from "@flmux/core/shell";
import { BrowserPaneRenderer } from "../panes/browserPane";
import { ExplorerPaneRenderer } from "../panes/explorerPane";
import { PlaceholderPaneRenderer } from "../panes/placeholderPane";
import { TerminalPaneRenderer } from "../panes/terminalPane";
import { TextEditorPaneRenderer } from "../panes/textEditorPane";
import { type PaneDescriptor, type PaneRegistry, isTerminalPaneRecord } from "./paneRegistry";

interface BuiltinPaneDescriptorDependencies {
  installRoot: string;
  resolveTerminalCwd(rootDir: string, inputCwd: string | undefined): string;
}

export function registerBuiltinPaneDescriptors(registry: PaneRegistry, deps: BuiltinPaneDescriptorDependencies) {
  for (const descriptor of createBuiltinPaneDescriptors(deps)) {
    registry.register(descriptor);
  }
}

function createBuiltinPaneDescriptors(deps: BuiltinPaneDescriptorDependencies): PaneDescriptor[] {
  const browserSpec = createBrowserPaneSpec();
  return [
    {
      ...browserSpec,
      createRenderer: ({ runtime }) =>
        new BrowserPaneRenderer({
          panelTemplate: runtime.browserPanelTemplate,
          normalizeUrl: runtime.normalizeBrowserUrl,
          onUrlChange: runtime.onBrowserUrlChange
        })
    },
    {
      kind: "explorer",
      defaultTitle: "Explorer",
      iconUrl: "/__flmux/assets/folder.svg",
      edgeGroup: "left",
      singletonScope: "workspace",
      createRenderer: ({ runtime }) =>
        new ExplorerPaneRenderer({
          shellModel: runtime.shellModel,
          userLabel: runtime.userLabel,
          canUpload: runtime.canUpload
        }),
      lifecycle: {
        createParams: ({ input }) => explorerParams(input.params),
        getTitle: ({ params }) => explorerTitle(optionalStringParam(params?.root) ?? "/")
      },
      persistence: {
        normalizeRestoredParams: ({ params }) => explorerParams(params),
        serializeParams: ({ currentParams }) => explorerParams(currentParams)
      }
    },
    {
      kind: "textEditor",
      defaultTitle: "Text Editor",
      newMenu: false,
      createRenderer: ({ runtime }) =>
        new TextEditorPaneRenderer({
          shellModel: runtime.shellModel
        }),
      lifecycle: {
        createParams: ({ input }) => textEditorParams(input.params),
        getTitle: ({ params }) => textEditorTitle(optionalStringParam(params?.path) ?? "")
      },
      persistence: {
        normalizeRestoredParams: ({ params }) => textEditorParams(params),
        serializeParams: ({ currentParams }) => textEditorParams(currentParams)
      }
    },
    {
      kind: "terminal",
      createRenderer: ({ runtime }) =>
        new TerminalPaneRenderer({
          shellModel: runtime.shellModel,
          subscribeTerminalEvents: runtime.subscribeTerminalEvents
        }),
      lifecycle: {
        createParams: ({ input }) => ({
          cwd: deps.resolveTerminalCwd(deps.installRoot, input.cwd)
        }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ params }) => ({
          kind: "terminal",
          cwd: deps.resolveTerminalCwd(deps.installRoot, optionalStringParam(params?.cwd)),
          rootKey: null,
          runtimeId: null,
          summary: null
        }),
        createSnapshot: ({ paneId, title, record }) =>
          isTerminalPaneRecord(record)
            ? {
                id: paneId,
                kind: "terminal",
                title,
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
                title
              }
      },
      subtreeMounts: [
        {
          mountKey: "terminal",
          getStateSnapshot: ({ record }) => (isTerminalPaneRecord(record) ? { cwd: record.cwd } : undefined),
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
        serializeParams: ({ record }) => (isTerminalPaneRecord(record) ? { cwd: record.cwd } : undefined)
      }
    },
    {
      kind: PLACEHOLDER_PANE_KIND,
      createRenderer: () => new PlaceholderPaneRenderer()
    }
  ];
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function explorerParams(params: Record<string, unknown> | undefined) {
  return { root: optionalStringParam(params?.root) ?? "/" };
}

function explorerTitle(root: string) {
  return root === "/" ? "Explorer" : `Explorer (${root})`;
}

function textEditorParams(params: Record<string, unknown> | undefined) {
  return { path: optionalStringParam(params?.path) ?? "" };
}

function textEditorTitle(path: string) {
  if (!path) return "Text Editor";
  // Split on both separators — desktop unconfined accepts native Windows paths.
  const trimmed = path.replace(/[\\/]+$/, "");
  return (
    trimmed
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || "Text Editor"
  );
}
