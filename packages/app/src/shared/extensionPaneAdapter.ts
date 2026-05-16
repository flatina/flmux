import type { ExtensionPaneSpec, ExtensionPanePathMount } from "@flmux/extension-api";
import type { PaneLifecycleHooks, PanePathMount, PanePersistenceHooks } from "@flmux/core/shell";

export function adaptExtensionLifecycle(spec: ExtensionPaneSpec): PaneLifecycleHooks | undefined {
  if (!spec.createParams && !spec.getTitle) {
    return undefined;
  }
  return {
    createParams: spec.createParams
      ? ({ workspace, input }) =>
          spec.createParams!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            input
          })
      : undefined,
    getTitle: spec.getTitle
      ? ({ workspace, input, params }) =>
          spec.getTitle!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            input,
            params
          })
      : undefined
  };
}

export function adaptExtensionPersistence(spec: ExtensionPaneSpec): PanePersistenceHooks | undefined {
  if (!spec.normalizeRestoredParams && !spec.serializeParams) {
    return undefined;
  }
  return {
    normalizeRestoredParams: spec.normalizeRestoredParams
      ? ({ workspace, params }) =>
          spec.normalizeRestoredParams!({
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            params
          })
      : undefined,
    serializeParams: spec.serializeParams
      ? ({ workspace, currentParams }) =>
          spec.serializeParams!({
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
    canCallStatePath: source.canCallStatePath
      ? ({ paneId, workspace, currentParams }, relativePath) =>
          source.canCallStatePath!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams,
            relativePath
          })
      : undefined,
    callState: source.callState
      ? ({ paneId, workspace, currentParams, setParams, patchParams }, relativePath, args) =>
          source.callState!({
            paneId,
            workspaceId: workspace.id,
            defaultBrowserPath: workspace.defaultBrowserPath,
            currentParams,
            relativePath,
            args,
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
