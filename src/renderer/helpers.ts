import type { SerializedDockview } from "dockview-core";
import type { PaneCreateInput, PaneSummary } from "../shared/app-rpc";
import { asPaneId, type TabId } from "../shared/ids";
import {
  type BrowserPaneParams,
  getDefaultPaneTitle,
  type PaneParams,
  type TerminalPaneParams
} from "../shared/pane-params";
import { createSimpleTabParams, isLayoutableTabParams, isTabParams } from "../shared/tab-params";

export function buildPaneHeader(kind: string, status: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "pane-header";

  const kindLabel = document.createElement("span");
  kindLabel.className = "pane-kind";
  kindLabel.textContent = kind;

  const statusLabel = document.createElement("span");
  statusLabel.className = "pane-status";
  statusLabel.textContent = status;

  header.append(kindLabel, statusLabel);
  return header;
}

export function buildNote(text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "pane-note";
  note.textContent = text;
  return note;
}

export function extractWebviewUrl(detail: unknown): string | null {
  if (typeof detail === "string" && detail.length > 0) {
    return normalizeBrowserUrlValue(detail);
  }

  if (detail && typeof detail === "object") {
    const candidate = (detail as { url?: unknown }).url;
    if (typeof candidate === "string" && candidate.length > 0) {
      return normalizeBrowserUrlValue(candidate);
    }
  }

  return null;
}

export function normalizeBrowserUrlValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url.trim().length > 0) {
      return parsed.url.trim();
    }
  } catch {
    // keep original string when it is not JSON
  }

  return trimmed;
}

export function sanitizeSerializedLayout(layout: SerializedDockview): {
  changed: boolean;
  layout: SerializedDockview;
} {
  let changed = false;
  const nextLayout = structuredClone(layout);

  for (const panel of Object.values(nextLayout.panels)) {
    const params = panel.params;

    if (isLegacyExtensionTabParams(params)) {
      panel.params = createSimpleTabParams({
        kind: "extension",
        extensionId: params.ownerExtensionId,
        contributionId: params.contributionId
      });
      changed = true;
    }

    const canonicalParams = panel.params;

    if (isBrowserPaneParams(canonicalParams)) {
      const normalizedUrl = normalizeBrowserUrlValue(canonicalParams.url);
      const normalizedTitle = browserTitleFromUrl(normalizedUrl);

      if (normalizedUrl !== canonicalParams.url) {
        panel.params = {
          ...canonicalParams,
          url: normalizedUrl
        };
        changed = true;
      }

      if (panel.title !== normalizedTitle) {
        panel.title = normalizedTitle;
        changed = true;
      }
    }

    // Recursively sanitize inner layouts in layoutable tabs
    if (isLayoutableTabParams(canonicalParams) && canonicalParams.innerLayout) {
      const innerResult = sanitizeSerializedLayout(canonicalParams.innerLayout as SerializedDockview);
      if (innerResult.changed) {
        panel.params = { ...canonicalParams, innerLayout: innerResult.layout };
        changed = true;
      }
    }
  }

  return {
    changed,
    layout: nextLayout
  };
}

export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    return "about:blank";
  }

  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("about:")) {
    return value;
  }

  if (value.includes(".") && !value.includes(" ")) {
    return `https://${value}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function browserTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(normalizeBrowserUrlValue(url));
    return parsed.hostname || "Browser";
  } catch {
    return "Browser";
  }
}

export function titleFromLeaf(leaf: PaneCreateInput): string {
  if (leaf.title && leaf.title.trim().length > 0) {
    return leaf.title.trim();
  }

  if (leaf.kind === "browser" && leaf.url) {
    return browserTitleFromUrl(leaf.url);
  }

  return getDefaultPaneTitle(leaf.kind);
}

export function panelToSummary(paneId: string, tabId: TabId, title: string, params: PaneParams): PaneSummary {
  const summary: PaneSummary = {
    paneId: asPaneId(paneId),
    tabId,
    kind: params.kind,
    title
  };

  switch (params.kind) {
    case "terminal":
      summary.runtimeId = params.runtimeId;
      break;
    case "browser":
      summary.url = normalizeBrowserUrlValue(params.url);
      break;
    case "editor":
      summary.filePath = params.filePath;
      break;
    case "explorer":
      summary.rootPath = params.rootPath;
      break;
    case "extension":
      summary.extensionId = params.extensionId;
      summary.contributionId = params.contributionId;
      break;
  }

  return summary;
}

export function isTerminalPaneParams(value: unknown): value is TerminalPaneParams {
  if (!value || typeof value !== "object") {
    return false;
  }

  const params = value as Partial<TerminalPaneParams>;
  return (
    params.kind === "terminal" &&
    typeof params.runtimeId === "string" &&
    (params.renderer === "xterm" || params.renderer === "ghostty")
  );
}

export function isBrowserPaneParams(value: unknown): value is BrowserPaneParams {
  if (!value || typeof value !== "object") {
    return false;
  }

  const params = value as Partial<BrowserPaneParams>;
  return (
    params.kind === "browser" &&
    typeof params.url === "string" &&
    (params.adapter === "electrobun-native" || params.adapter === "web-iframe")
  );
}

/** Detect a v1 flat layout (panels have PaneParams without tab wrapping). */
export function isV1Layout(layout: SerializedDockview): boolean {
  for (const panel of Object.values(layout.panels)) {
    if (panel.params && typeof panel.params === "object" && !isTabParams(panel.params)) {
      return true;
    }
  }
  return false;
}

/** Migrate a v1 flat layout to v2 by wrapping each panel's params as a simple tab. */
export function migrateV1Layout(layout: SerializedDockview): SerializedDockview {
  const migrated = structuredClone(layout);
  for (const panel of Object.values(migrated.panels)) {
    const params = panel.params;
    if (!params || typeof params !== "object" || isTabParams(params)) {
      continue;
    }
    const kind = (params as { kind?: string }).kind;
    if (!kind) {
      continue;
    }
    panel.params = createSimpleTabParams(params as PaneParams);
  }
  return migrated;
}

function isLegacyExtensionTabParams(
  value: unknown
): value is { tabKind: "tab"; layoutMode: "simple"; ownerExtensionId: string; contributionId: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const params = value as Record<string, unknown>;
  return (
    params.tabKind === "tab" &&
    params.layoutMode === "simple" &&
    typeof params.ownerExtensionId === "string" &&
    typeof params.contributionId === "string"
  );
}
