import {
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  normalizeBrowserUrl,
  type NewPaneInput,
  type PaneSpec,
  type ShellModelAPI
} from "@flmux/core/shell";
import type {
  ExtensionDefinition,
  ExtensionManifestPane,
  ExtensionPaneDefinition
} from "@flmux/extension-api";
import { pathToFileURL } from "node:url";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { resolveTerminalCwdFromRoot } from "../shared/terminalPath";
import {
  adaptExtensionLifecycle,
  adaptExtensionPanePathMount,
  adaptExtensionPersistence
} from "../shared/extensionPaneAdapter";
import type { TerminalService } from "./terminal-service";
import { createServerShellModelRouter } from "./serverShellModelRouter";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { DiscoveredLocalExtension } from "./localExtensions";

type ExtensionModule = { default?: ExtensionDefinition };
export type ExtensionModuleImporter = (entryPath: string) => Promise<ExtensionModule>;

export interface WebModeShellAuthority {
  readonly clientId: string;
  readonly shellModel: ShellModelAPI;
  readonly router: ReturnType<typeof createServerShellModelRouter>;
  start(origin: string): Promise<void>;
  applyTerminalEvent(event: TerminalRuntimeEvent): void;
}

export async function createWebModeShellAuthority(options: {
  projectDir: string;
  runtimeLabel: string;
  terminalService: TerminalService;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  extensionModuleImporter?: ExtensionModuleImporter;
}): Promise<WebModeShellAuthority> {
  const paneRegistry = new PaneRegistry<PaneSpec>();
  paneRegistry.register(createPlaceholderPaneSpec());
  for (const spec of createBuiltinPaneSpecs(options.projectDir)) {
    paneRegistry.register(spec);
  }
  const extensionPaneSpecs = await createExtensionPaneSpecs(
    options.localExtensions ?? [],
    options.extensionModuleImporter ?? defaultImportExtensionModule
  );
  for (const spec of extensionPaneSpecs) {
    paneRegistry.register(spec);
  }

  const shellCore = new ShellCore({
    paneRegistry,
    runtimeLabel: options.runtimeLabel,
    projectDir: options.projectDir,
    terminalBackend: options.terminalService
  });
  const shellModel = createShellModel({
    host: shellCore,
    terminal: shellCore.createTerminalDelegate()
  });
  const clientId = `server_${crypto.randomUUID()}`;

  return {
    clientId,
    shellModel,
    router: createServerShellModelRouter({
      authorityClientId: clientId,
      shellModel,
      getWorkspace: async () => shellCore.getWorkspaceStatus(),
      clientRegistry: options.clientRegistry
    }),
    async start(origin: string) {
      shellCore.setAppOrigin(origin);
      shellCore.initialize();
    },
    applyTerminalEvent(event) {
      shellCore.applyTerminalEvent(event);
    }
  };
}

function createBuiltinPaneSpecs(projectDir: string): PaneSpec[] {
  return [
    {
      kind: "browser",
      lifecycle: {
        createParams: ({ workspace, input }) => ({
          url: normalizeBrowserUrl("", workspace.appOrigin, input.url ?? workspace.defaultBrowserPath, workspace.defaultBrowserPath)
        }),
        getTitle: ({ input, params }) =>
          input.title?.trim() || inferBrowserTitle(optionalStringParam(params?.url) ?? "Browser"),
        createRecord: ({ workspace, params }) => ({
          kind: "browser",
          url: normalizeBrowserUrl("", workspace.appOrigin, optionalStringParam(params?.url) ?? workspace.defaultBrowserPath, workspace.defaultBrowserPath)
        }),
        createSnapshot: ({ paneId, title, active, record }) =>
          isBrowserPaneStateRecord(record)
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

            const nextUrl = normalizeBrowserUrl("", workspace.appOrigin, requiredString(value, "Pane url"), workspace.defaultBrowserPath);
            record.url = nextUrl;
            await setParams({
              ...(currentParams ?? {}),
              url: nextUrl
            });
            return { value: nextUrl };
          },
          getStatusSnapshot: ({ record }) =>
            isBrowserPaneStateRecord(record) ? { url: record.url } : undefined
        }
      ]
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
        createSnapshot: ({ paneId, title, active, record }) =>
          isTerminalPaneStateRecord(record)
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
            isTerminalPaneStateRecord(record) ? { cwd: record.cwd } : undefined,
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

async function createExtensionPaneSpecs(
  extensions: readonly DiscoveredLocalExtension[],
  importer: ExtensionModuleImporter
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
  const entryPath = extension.rendererEntryPath;
  if (!entryPath) {
    return byKind;
  }
  try {
    const module = await importer(entryPath);
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

  if (!definition) {
    if (!defaultTitle) {
      return { kind: manifestPane.kind };
    }
    return {
      kind: manifestPane.kind,
      lifecycle: {
        getTitle: ({ input }) => input.title?.trim() || defaultTitle
      }
    };
  }

  const lifecycle = adaptExtensionLifecycle(definition);
  const hasFallbackTitle = Boolean(defaultTitle);
  const mergedLifecycle = hasFallbackTitle && !lifecycle?.getTitle
    ? {
        ...(lifecycle ?? {}),
        getTitle: ({ input }: { input: NewPaneInput }) => input.title?.trim() || defaultTitle!
      }
    : lifecycle;

  return {
    kind: manifestPane.kind,
    lifecycle: mergedLifecycle,
    persistence: adaptExtensionPersistence(definition),
    pathMount: definition.pathMount ? adaptExtensionPanePathMount(definition.pathMount) : undefined
  };
}

async function defaultImportExtensionModule(entryPath: string): Promise<ExtensionModule> {
  const fileUrl = pathToFileURL(entryPath).href;
  return await import(fileUrl);
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
