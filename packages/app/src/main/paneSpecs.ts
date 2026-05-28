import {
  createBrowserPaneSpec,
  isTerminalPaneStateRecord,
  PRIMITIVE_OPS,
  type BrowserPaneController,
  type NewPaneInput,
  type PaneSpec
} from "@flmux/core/shell";
import { AGENT_OPS } from "./browserAgentSurface";
import type {
  ExtensionManifestPane,
  ExtensionPaneSpec,
  ExtensionServerDefinition
} from "@flmux/extension-api";
import { resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";
import {
  adaptExtensionLifecycle,
  adaptExtensionPanePathMount,
  adaptExtensionPersistence
} from "../shared/extensionPaneAdapter";
import type { DiscoveredLocalExtension } from "./localExtensions";

type ServerModule = { default?: ExtensionServerDefinition };
export type ExtensionModuleImporter = (entryUrl: string) => Promise<ServerModule>;

const BROWSER_CALLABLE_OPS: ReadonlySet<string> = new Set([...PRIMITIVE_OPS, ...AGENT_OPS]);

export function createBuiltinPaneSpecs(
  projectDir: string,
  options: { browserController?: BrowserPaneController } = {}
): PaneSpec[] {
  return [
    createBrowserPaneSpec({ controller: options.browserController, callableOps: BROWSER_CALLABLE_OPS }),
    {
      kind: "explorer",
      edgeGroup: "left",
      singletonScope: "workspace",
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
      newMenu: false,
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
      lifecycle: {
        createParams: ({ input }) => ({
          cwd: resolveTerminalCwdFromRoot(projectDir, input.cwd)
        }),
        getTitle: ({ input }) => input.title?.trim() || "Terminal",
        createRecord: ({ params }) => ({
          kind: "terminal",
          cwd: resolveTerminalCwdFromRoot(projectDir, optionalStringParam(params?.cwd)),
          rootKey: null,
          runtimeId: null,
          summary: null
        }),
        createSnapshot: ({ paneId, title, record }) =>
          isTerminalPaneStateRecord(record)
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
          getStateSnapshot: ({ record }) => (isTerminalPaneStateRecord(record) ? { cwd: record.cwd } : undefined),
          getStatusSnapshot: ({ record }) =>
            isTerminalPaneStateRecord(record)
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
      ]
    }
  ];
}

// Host pane specs come from each extension's server entry, never the
// renderer. This keeps renderer code from evaluating in the Bun process
// (would crash on DOM globals).
export async function createExtensionPaneSpecs(
  extensions: readonly DiscoveredLocalExtension[],
  importer: ExtensionModuleImporter = defaultImportServerModule
): Promise<PaneSpec[]> {
  const specs: PaneSpec[] = [];
  for (const extension of extensions) {
    const specByKind = await loadExtensionPaneSpecs(extension, importer);
    for (const manifestPane of extension.runtimeManifest.panes ?? []) {
      specs.push(createExtensionPaneSpec(manifestPane, specByKind.get(manifestPane.kind)));
    }
  }
  return specs;
}

async function loadExtensionPaneSpecs(
  extension: DiscoveredLocalExtension,
  importer: ExtensionModuleImporter
): Promise<Map<string, ExtensionPaneSpec>> {
  const byKind = new Map<string, ExtensionPaneSpec>();
  const serverRel = extension.serverEntryRelativePath;
  if (!serverRel) return byKind;
  const entryUrl = await extension.resolveEntryImportUrl(serverRel);
  if (!entryUrl) {
    console.warn(
      `[flmux] could not resolve server entry URL for extension '${extension.id}' (${extension.originPath})`
    );
    return byKind;
  }
  try {
    const module = await importer(entryUrl);
    for (const spec of module.default?.panes ?? []) {
      byKind.set(spec.kind, spec);
    }
  } catch (error) {
    console.warn(
      `[flmux] failed to load server entry for extension '${extension.id}' — pane specs unavailable`,
      error
    );
  }
  return byKind;
}

function createExtensionPaneSpec(
  manifestPane: ExtensionManifestPane,
  spec: ExtensionPaneSpec | undefined
): PaneSpec {
  const defaultTitle = manifestPane.defaultTitle;
  // edgeGroup implies workspace singleton — explicit singletonScope still wins.
  const singletonScope = manifestPane.singletonScope ?? (manifestPane.edgeGroup ? "workspace" : undefined);
  const edgeGroup = manifestPane.edgeGroup;
  const newMenu = manifestPane.newMenu;

  if (!spec) {
    if (!defaultTitle) {
      return { kind: manifestPane.kind, singletonScope, edgeGroup, newMenu };
    }
    return {
      kind: manifestPane.kind,
      singletonScope,
      edgeGroup,
      newMenu,
      lifecycle: {
        getTitle: ({ input }) => input.title?.trim() || defaultTitle
      }
    };
  }

  const lifecycle = adaptExtensionLifecycle(spec);
  const hasFallbackTitle = Boolean(defaultTitle);
  const mergedLifecycle =
    hasFallbackTitle && !lifecycle?.getTitle
      ? {
          ...(lifecycle ?? {}),
          getTitle: ({ input }: { input: NewPaneInput }) => input.title?.trim() || defaultTitle!
        }
      : lifecycle;

  return {
    kind: manifestPane.kind,
    singletonScope,
    edgeGroup,
    newMenu,
    lifecycle: mergedLifecycle,
    persistence: adaptExtensionPersistence(spec),
    pathMount: spec.pathMount ? adaptExtensionPanePathMount(spec.pathMount) : undefined
  };
}

async function defaultImportServerModule(entryUrl: string): Promise<ServerModule> {
  return await import(/* @vite-ignore */ entryUrl);
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
  return trimmed.split(/[\\/]+/).filter(Boolean).pop() || "Text Editor";
}
