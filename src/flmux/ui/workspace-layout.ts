import type { DockviewApi } from "dockview-core";
import type { PaneSummary, WorkspaceSummary } from "../model/workspace-types";
import { asPaneId, asTabId, type PaneId, type TabId } from "../../lib/ids";
import { getDefaultPaneTitle, isPaneParams, type PaneParams } from "../model/pane-params";
import { browserTitleFromUrl, panelToSummary } from "./helpers";
import type { TabRenderer } from "./tabs/tab-renderer";

export type PaneLookup = {
  outerPanel: { id: string; focus: () => void; api: { close: () => void }; params: Record<string, unknown> };
  innerApi: DockviewApi | null;
  innerPanel: {
    id: string;
    focus: () => void;
    api: { close: () => void };
    params: Record<string, unknown>;
    title?: string;
  } | null;
};

type WorkspacePaneVisit = {
  tabId: TabId;
  paneId: PaneId;
  title: string;
  params: PaneParams;
};

export function collectWorkspacePaneSummaries(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>
): PaneSummary[] {
  const panes: PaneSummary[] = [];
  forEachWorkspacePane(dockview, tabRenderers, ({ paneId, tabId, title, params }) => {
    panes.push(panelToSummary(paneId, tabId, title, params));
  });
  return panes;
}

export function collectWorkspaceTabSummaries(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>
): WorkspaceSummary[] {
  if (!dockview) {
    return [];
  }

  const tabs: WorkspaceSummary[] = [];
  for (const panel of dockview.panels) {
    const renderer = tabRenderers.get(panel.id);
    const layoutMode = renderer?.isLayoutable ? "layoutable" : "simple";
    const paneCount = renderer?.isLayoutable && renderer.innerApi ? renderer.innerApi.panels.length : 1;
    tabs.push({
      tabId: asTabId(panel.id),
      layoutMode,
      title: panel.title ?? "Tab",
      paneCount
    });
  }

  return tabs;
}

export function findWorkspacePane(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  paneId: PaneId
): PaneLookup | null {
  if (!dockview) {
    return null;
  }

  const outerPanel = dockview.getPanel(paneId);
  if (outerPanel) {
    return { outerPanel: outerPanel as any, innerApi: null, innerPanel: null };
  }

  for (const [tabId, renderer] of tabRenderers) {
    if (!renderer.isLayoutable || !renderer.innerApi) {
      continue;
    }

    const innerPanel = renderer.innerApi.getPanel(paneId);
    if (!innerPanel) {
      continue;
    }

    const outer = dockview.getPanel(tabId);
    if (!outer) {
      continue;
    }

    return { outerPanel: outer as any, innerApi: renderer.innerApi, innerPanel: innerPanel as any };
  }

  return null;
}

export function focusWorkspacePane(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  paneId: PaneId
): boolean {
  const found = findWorkspacePane(dockview, tabRenderers, paneId);
  if (!found) {
    return false;
  }

  found.outerPanel.focus();
  found.innerPanel?.focus();
  return true;
}

export function getWorkspaceActivePaneId(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>
): PaneId | null {
  if (!dockview?.activePanel) {
    return null;
  }

  const renderer = tabRenderers.get(dockview.activePanel.id);
  if (renderer?.isLayoutable && renderer.innerApi?.activePanel) {
    return asPaneId(renderer.innerApi.activePanel.id);
  }

  return asPaneId(dockview.activePanel.id);
}

export function findWorkspaceActiveInnerPaneId(tabRenderers: Map<string, TabRenderer>): PaneId | undefined {
  for (const renderer of tabRenderers.values()) {
    if (renderer.isLayoutable && renderer.innerApi?.activePanel) {
      return asPaneId(renderer.innerApi.activePanel.id);
    }
  }

  return undefined;
}

export function findActiveLayoutableTab(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>
): { tabId: string; renderer: TabRenderer } | null {
  const activeTabId = dockview?.activePanel?.id;
  if (!activeTabId) {
    return null;
  }

  const renderer = tabRenderers.get(activeTabId);
  if (!renderer?.isLayoutable) {
    return null;
  }

  return { tabId: activeTabId, renderer };
}

function forEachWorkspacePane(
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  visit: (pane: WorkspacePaneVisit) => void
): void {
  if (!dockview) {
    return;
  }

  for (const panel of dockview.panels) {
    const tabId = asTabId(panel.id);
    const renderer = tabRenderers.get(panel.id);
    if (renderer?.isLayoutable && renderer.innerApi) {
      for (const innerPanel of renderer.innerApi.panels) {
        const innerParams = innerPanel.params as PaneParams;
        if (!isPaneParams(innerParams)) {
          continue;
        }

        visit({
          tabId,
          paneId: asPaneId(innerPanel.id),
          title: innerPanel.title ?? getDefaultPaneTitle(innerParams.kind),
          params: innerParams
        });
      }
      continue;
    }

    const params = panel.params as PaneParams;
    if (!isPaneParams(params)) {
      continue;
    }

    visit({
      tabId,
      paneId: asPaneId(panel.id),
      title: panel.title ?? browserTitleFromUrl(params.kind === "browser" ? params.url : ""),
      params
    });
  }
}
