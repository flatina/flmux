import { createBrowserPaneSpec, isTerminalPaneStateRecord, type NewPaneInput, type PaneSpec } from "@flmux/core/shell";
import type { ExtensionDefinition, ExtensionManifestPane, ExtensionPaneDefinition } from "@flmux/extension-api";
import { resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";
import {
  adaptExtensionLifecycle,
  adaptExtensionPanePathMount,
  adaptExtensionPersistence
} from "../shared/extensionPaneAdapter";
import type { DiscoveredLocalExtension } from "./localExtensions";

type ExtensionModule = { default?: ExtensionDefinition };
export type ExtensionModuleImporter = (entryUrl: string) => Promise<ExtensionModule>;

export function createBuiltinPaneSpecs(projectDir: string): PaneSpec[] {
  return [
    createBrowserPaneSpec(),
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

export async function createExtensionPaneSpecs(
  extensions: readonly DiscoveredLocalExtension[],
  importer: ExtensionModuleImporter = defaultImportExtensionModule
): Promise<PaneSpec[]> {
  const specs: PaneSpec[] = [];
  for (const extension of extensions) {
    const definitionByKind = await loadExtensionPaneDefinitions(extension, importer);
    for (const manifestPane of extension.runtimeManifest.panes ?? []) {
      specs.push(createExtensionPaneSpec(manifestPane, definitionByKind.get(manifestPane.kind)));
    }
  }
  return specs;
}

async function loadExtensionPaneDefinitions(
  extension: DiscoveredLocalExtension,
  importer: ExtensionModuleImporter
): Promise<Map<string, ExtensionPaneDefinition>> {
  const byKind = new Map<string, ExtensionPaneDefinition>();
  const rendererRel = extension.rendererEntryRelativePath;
  if (!rendererRel) {
    return byKind;
  }
  const entryUrl = await extension.resolveEntryImportUrl(rendererRel);
  if (!entryUrl) {
    console.warn(
      `[flmux] could not resolve renderer entry URL for extension '${extension.id}' (${extension.originPath})`
    );
    return byKind;
  }
  try {
    const module = await importer(entryUrl);
    for (const pane of module.default?.panes ?? []) {
      byKind.set(pane.kind, pane);
    }
  } catch (error) {
    console.warn(
      `[flmux] failed to load extension '${extension.id}' for server authority — pathMount / lifecycle hooks unavailable`,
      error
    );
  }
  return byKind;
}

function createExtensionPaneSpec(
  manifestPane: ExtensionManifestPane,
  definition: ExtensionPaneDefinition | undefined
): PaneSpec {
  const defaultTitle = manifestPane.defaultTitle;
  const singletonScope = manifestPane.singletonScope;

  if (!definition) {
    if (!defaultTitle) {
      return { kind: manifestPane.kind, singletonScope };
    }
    return {
      kind: manifestPane.kind,
      singletonScope,
      lifecycle: {
        getTitle: ({ input }) => input.title?.trim() || defaultTitle
      }
    };
  }

  const lifecycle = adaptExtensionLifecycle(definition);
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
    lifecycle: mergedLifecycle,
    persistence: adaptExtensionPersistence(definition),
    pathMount: definition.pathMount ? adaptExtensionPanePathMount(definition.pathMount) : undefined
  };
}

async function defaultImportExtensionModule(entryUrl: string): Promise<ExtensionModule> {
  return await import(/* @vite-ignore */ entryUrl);
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
