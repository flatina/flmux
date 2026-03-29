import type { SerializedDockview } from "dockview-core";
import { parseViewKey } from "../../lib/view-key";
import { asPaneId, type TabId } from "../../lib/ids";
import {
  type BrowserPaneParams,
  getDefaultPaneTitle,
  type PaneParams,
  type TerminalPaneParams
} from "../model/pane-params";
import { isLayoutableTabParams } from "../model/tab-params";
import type { PaneCreateInput } from "../../types/pane";
import type { PaneSummary } from "../model/workspace-types";

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

export function formatWorkspaceTitle(index: number, count: number, customTitle?: string | null): string {
  const trimmed = customTitle?.trim();
  if (trimmed) {
    return trimmed;
  }
  return `Workspace${index} (${count} Tabs)`;
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
      summary.cwd = params.cwd;
      summary.shell = params.shell;
      summary.renderer = params.renderer;
      break;
    case "browser":
      summary.url = normalizeBrowserUrlValue(readBrowserUrl(params));
      summary.adapter = params.adapter;
      break;
    case "editor":
      summary.filePath = readEditorFilePath(params);
      summary.language = params.language;
      break;
    case "explorer":
      summary.rootPath = params.rootPath;
      summary.mode = params.mode;
      break;
    case "view": {
      summary.viewKey = params.viewKey;
      const parsed = parseViewKey(params.viewKey);
      summary.extensionId = parsed?.extensionId;
      summary.viewId = parsed?.viewId;
      break;
    }
  }

  return summary;
}

export function readBrowserUrl(params: BrowserPaneParams): string {
  const candidate = (params.state as { url?: unknown } | undefined)?.url;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : params.url;
}

export function readEditorFilePath(params: Extract<PaneParams, { kind: "editor" }>): string | null {
  const candidate = (params.state as { filePath?: unknown } | undefined)?.filePath;
  return typeof candidate === "string" ? candidate : params.filePath;
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
