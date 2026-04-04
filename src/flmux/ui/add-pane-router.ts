import type { DockviewApi } from "dockview-core";
import { asPaneId, asTabId, type PaneId } from "../../lib/ids";
import type { PaneCreateDirection, PaneCreateInput } from "../../types/pane";
import type { ExtensionSetupRegistry } from "./ext/extension-setup-registry";
import { findBuiltinPaneSource } from "./pane-sources";
import { findWorkspacePane } from "./workspace-layout";
import type { TabRenderer } from "./tabs/tab-renderer";

export type AddPaneContext = {
  dockview: DockviewApi | null;
  tabRenderers: Map<string, TabRenderer>;
  setupRegistry: ExtensionSetupRegistry;
  openLeaf: (leaf: PaneCreateInput, options: { referencePaneId?: PaneId; direction?: PaneCreateDirection }) => Promise<unknown>;
  openPaneFromContext: (
    leaf: PaneCreateInput,
    placement: { referencePaneId?: PaneId; direction?: PaneCreateDirection },
    options?: { singleton?: boolean }
  ) => Promise<unknown>;
  openRegisteredWorkspaceTab: (qualifiedId: string) => void;
};

export function handleAddPaneAction(ctx: AddPaneContext, action: string, activePanelId: string | null): void {
  const ref = activePanelId ? asPaneId(activePanelId) : undefined;

  const extAction = ctx.setupRegistry.findWorkspaceAction(action);
  if (extAction) {
    const found = ref ? findWorkspacePane(ctx.dockview, ctx.tabRenderers, ref) : null;
    const tabId = found ? asTabId(found.outerPanel.id) : asTabId("");
    extAction.run({
      activePaneId: ref ?? null,
      tabId,
      openPane: (leaf: PaneCreateInput, placement?, options?) =>
        void ctx.openPaneFromContext(
          leaf,
          { referencePaneId: placement?.referencePaneId ?? ref, direction: placement?.direction },
          options
        ),
      openWorkspaceTab: (id: string) => {
        const qualifiedId = `${extAction.qualifiedId.split(":")[0] ?? extAction.qualifiedId}:${id}`;
        ctx.openRegisteredWorkspaceTab(qualifiedId);
      }
    });
    return;
  }

  const paneSourceAction = parsePaneSourcePlacementAction(action);
  if (paneSourceAction) {
    void openFromPaneSource(ctx, paneSourceAction.sourceId, paneSourceAction.placement, ref);
  }
}

async function openFromPaneSource(
  ctx: AddPaneContext,
  sourceId: string,
  placement: PaneCreateDirection | "default",
  referencePaneId?: PaneId
): Promise<void> {
  const paneSource = findBuiltinPaneSource(sourceId) ?? ctx.setupRegistry.findPaneSource(sourceId);
  if (!paneSource) return;

  const leaf = paneSource.createLeaf();
  const singleton = paneSource.options?.singleton ?? false;
  const direction = placement === "default"
    ? ("defaultPlacement" in paneSource ? paneSource.defaultPlacement : undefined)
    : placement;

  if (singleton && leaf.kind === "view") {
    if (focusExistingSingletonView(ctx, referencePaneId, leaf.viewKey)) return;
  }

  const resolved = direction ?? resolveAutoPlacement();
  await ctx.openLeaf(leaf, referencePaneId ? { referencePaneId, direction: resolved } : {});
}

export function focusExistingSingletonView(ctx: AddPaneContext, referencePaneId: PaneId | undefined, viewKey: string): boolean {
  const found = referencePaneId ? findWorkspacePane(ctx.dockview, ctx.tabRenderers, referencePaneId) : null;
  const innerApi = found ? ctx.tabRenderers.get(found.outerPanel.id)?.innerApi : null;
  if (!innerApi) return false;

  for (const panel of innerApi.panels) {
    const params = panel.params as Record<string, unknown>;
    if (params.kind === "view" && params.viewKey === viewKey) {
      panel.focus();
      return true;
    }
  }
  return false;
}

export function resolveAutoPlacement(): "right" | "below" {
  return window.innerWidth < window.innerHeight ? "below" : "right";
}

export function parsePaneSourcePlacementAction(
  action: string
): { sourceId: string; placement: PaneCreateDirection | "default" } | null {
  const prefix = "pane-source:";
  if (!action.startsWith(prefix)) return null;

  const rest = action.slice(prefix.length);
  const idx = rest.lastIndexOf(":");
  if (idx < 0) return null;

  const sourceId = rest.slice(0, idx);
  const placement = rest.slice(idx + 1);
  if (!["within", "left", "right", "above", "below", "default"].includes(placement)) return null;

  return { sourceId, placement: placement as PaneCreateDirection | "default" };
}
