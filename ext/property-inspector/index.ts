import {
  asPaneId,
  asTabId,
  defineView,
  type ViewPaneSummary,
  type ViewTabSummary
} from "flmux-sdk";
import { h, mustQuery, renderScopeCard, type CommitFn } from "./dom";

type InspectorState = {
  selectedTabId?: string | null;
  selectedPaneId?: string | null;
};

export default defineView<Record<string, never>, InspectorState>({
  createInstance(context) {
    let selectedTabId = context.state?.selectedTabId ?? String(context.tabId);
    let selectedPaneId = context.state?.selectedPaneId ?? null;
    let stale = false;
    let host: HTMLElement | null = null;
    let workspaceSelect: HTMLSelectElement | null = null;
    let paneSelect: HTMLSelectElement | null = null;
    let statusText: HTMLElement | null = null;
    let staleText: HTMLElement | null = null;
    let errorText: HTMLElement | null = null;
    let appCard: HTMLElement | null = null;
    let workspaceCard: HTMLElement | null = null;
    let paneCard: HTMLElement | null = null;
    let subscriptions: Array<() => void> = [];
    let tabs: ViewTabSummary[] = [];
    let panes: ViewPaneSummary[] = [];

    const commit: CommitFn = (handle, property, nextValue) => {
      try {
        clearError();
        handle.set(property.key, nextValue);
        refreshSnapshot();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    };

    return {
      async mount(nextHost) {
        host = nextHost;
        context.curPane.title = "Properties";
        host.innerHTML = await context.loadAssetText("./index.html");

        workspaceSelect = mustQuery<HTMLSelectElement>(host, "[data-ref='workspace-select']");
        paneSelect = mustQuery<HTMLSelectElement>(host, "[data-ref='pane-select']");
        const refreshButton = mustQuery<HTMLButtonElement>(host, "[data-ref='refresh-btn']");
        statusText = mustQuery(host, "[data-ref='status']");
        staleText = mustQuery(host, "[data-ref='stale']");
        errorText = mustQuery(host, "[data-ref='error']");
        appCard = mustQuery(host, "[data-ref='app-card']");
        workspaceCard = mustQuery(host, "[data-ref='workspace-card']");
        paneCard = mustQuery(host, "[data-ref='pane-card']");

        workspaceSelect.addEventListener("change", () => {
          selectedTabId = workspaceSelect?.value || selectedTabId;
          selectedPaneId = null;
          persistSelection();
          refreshSnapshot();
        });

        paneSelect.addEventListener("change", () => {
          selectedPaneId = paneSelect?.value || null;
          persistSelection();
          refreshSnapshot();
        });

        refreshButton.addEventListener("click", () => refreshSnapshot());

        refreshSnapshot();
      },
      dispose() {
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions = [];
        host?.replaceChildren();
        host = null;
      }
    };

    function refreshSnapshot(): void {
      tabs = context.listTabs();
      panes = context.getAppSummary().panes;
      selectedTabId = normalizeSelectedTabId(tabs, selectedTabId, String(context.tabId));
      selectedPaneId = normalizeSelectedPaneId(panes, selectedTabId, selectedPaneId, String(context.paneId));
      stale = false;
      persistSelection();
      clearError();
      renderSelectors();
      renderStatus();
      renderCards();
      bindCurrentSubscriptions();
    }

    function renderSelectors(): void {
      if (!workspaceSelect || !paneSelect) return;

      workspaceSelect.replaceChildren();
      for (const tab of tabs) {
        workspaceSelect.append(
          h("option", { value: String(tab.tabId), selected: String(tab.tabId) === selectedTabId },
            `${tab.title} (${tab.layoutMode})`)
        );
      }

      paneSelect.replaceChildren();
      const panesInTab = panes.filter((pane) => String(pane.tabId) === selectedTabId);
      for (const pane of panesInTab) {
        paneSelect.append(
          h("option", { value: String(pane.paneId), selected: String(pane.paneId) === selectedPaneId },
            `${pane.title} [${pane.kind}]`)
        );
      }
      paneSelect.disabled = panesInTab.length === 0;
    }

    function renderStatus(): void {
      if (!statusText || !staleText) return;
      const summary = context.getAppSummary();
      statusText.textContent = `snapshot tabs=${tabs.length} panes=${summary.panes.length} activePane=${String(summary.activePaneId ?? "none")}`;
      staleText.textContent = stale ? "External changes detected. Refresh to sync snapshot." : "";
    }

    function renderCards(): void {
      if (!appCard || !workspaceCard || !paneCard) return;

      renderScopeCard(appCard, "App", "Global app properties", context.app.props, commit);

      const workspaceHandle = tabs.some((tab) => String(tab.tabId) === selectedTabId)
        ? context.getWorkspace(asTabId(selectedTabId))
        : null;
      renderScopeCard(
        workspaceCard,
        "Workspace",
        workspaceHandle ? `${workspaceHandle.tabId}` : "No workspace selected",
        workspaceHandle?.props ?? null,
        commit
      );

      const paneSummary = panes.find((pane) => String(pane.paneId) === selectedPaneId) ?? null;
      const paneHandle = paneSummary ? context.getPane(asPaneId(String(paneSummary.paneId))) : null;
      renderScopeCard(
        paneCard,
        "Pane",
        paneSummary ? `${paneSummary.title} (${paneSummary.kind})` : "No pane selected",
        paneHandle?.props ?? null,
        commit
      );
    }

    function bindCurrentSubscriptions(): void {
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];

      const markStale = () => {
        stale = true;
        renderStatus();
      };

      subscriptions.push(context.app.on("change", markStale));

      if (selectedTabId && tabs.some((tab) => String(tab.tabId) === selectedTabId)) {
        subscriptions.push(context.getWorkspace(asTabId(selectedTabId)).on("change", markStale));
      }

      if (selectedPaneId && panes.some((pane) => String(pane.paneId) === selectedPaneId)) {
        subscriptions.push(context.getPane(asPaneId(selectedPaneId)).on("change", markStale));
      }
    }

    function persistSelection(): void {
      context.setState({ selectedTabId, selectedPaneId });
    }

    function setError(message: string): void {
      if (errorText) errorText.textContent = message;
    }

    function clearError(): void {
      if (errorText) errorText.textContent = "";
    }
  }
});

function normalizeSelectedTabId(
  tabs: ViewTabSummary[],
  selectedTabId: string | null | undefined,
  fallback: string
): string {
  if (selectedTabId && tabs.some((tab) => String(tab.tabId) === selectedTabId)) return selectedTabId;
  return String(tabs[0]?.tabId ?? fallback);
}

function normalizeSelectedPaneId(
  panes: ViewPaneSummary[],
  selectedTabId: string,
  selectedPaneId: string | null | undefined,
  fallbackPaneId: string
): string | null {
  const panesInTab = panes.filter((pane) => String(pane.tabId) === selectedTabId);
  if (selectedPaneId && panesInTab.some((pane) => String(pane.paneId) === selectedPaneId)) return selectedPaneId;
  const fallback = panesInTab.find((pane) => String(pane.paneId) === fallbackPaneId) ?? panesInTab[0] ?? null;
  return fallback ? String(fallback.paneId) : null;
}
