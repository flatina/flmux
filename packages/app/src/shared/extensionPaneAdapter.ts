import type { ExtensionPaneDefinition, ExtensionPanePathMount } from "@flmux/extension-api";
import type { PaneLifecycleHooks, PanePathMount, PanePersistenceHooks } from "@flmux/core/shell";

export function adaptExtensionLifecycle(definition: ExtensionPaneDefinition): PaneLifecycleHooks | undefined {
  if (!definition.createParams && !definition.getTitle) {
    return undefined;
  }
  return {
    createParams: definition.createParams
      ? ({ workspace, input }) =>
          definition.createParams!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            input
          })
      : undefined,
    getTitle: definition.getTitle
      ? ({ workspace, input, params }) =>
          definition.getTitle!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            input,
            params
          })
      : undefined
  };
}

export function adaptExtensionPersistence(definition: ExtensionPaneDefinition): PanePersistenceHooks | undefined {
  if (!definition.normalizeRestoredParams && !definition.serializeParams) {
    return undefined;
  }
  return {
    normalizeRestoredParams: definition.normalizeRestoredParams
      ? ({ workspace, params }) =>
          definition.normalizeRestoredParams!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            params
          })
      : undefined,
    serializeParams: definition.serializeParams
      ? ({ workspace, currentParams }) =>
          definition.serializeParams!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams
          })
      : undefined
  };
}

export function adaptExtensionPanePathMount(source: ExtensionPanePathMount): PanePathMount {
  return {
    mountKey: source.mountKey,
    getStateSnapshot: source.getStateSnapshot
      ? ({ paneId, workspace, currentParams }) =>
          source.getStateSnapshot!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams
          })
      : undefined,
    canSetStatePath: source.canSetStatePath
      ? ({ paneId, workspace, currentParams }, relativePath) =>
          source.canSetStatePath!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams,
            relativePath
          })
      : undefined,
    setState: source.setState
      ? ({ paneId, workspace, currentParams, setParams, patchParams }, relativePath, value) =>
          source.setState!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams,
            relativePath,
            value,
            setParams: async (nextParams) => await setParams(nextParams),
            patchParams: async (patch) => await patchParams(patch)
          })
      : undefined,
    getStatusSnapshot: source.getStatusSnapshot
      ? ({ paneId, workspace, currentParams }) =>
          source.getStatusSnapshot!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams
          })
      : undefined
  };
}
