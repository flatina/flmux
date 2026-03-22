import type { PaneId } from "./ids";
import type { PaneKind } from "./pane-params";

export type LayoutMode = "simple" | "stack" | "layoutable";

export interface SimpleTabParams {
  tabKind: "tab";
  layoutMode: "simple";
  paneKind: PaneKind;
}

export interface StackTabParams {
  tabKind: "tab";
  layoutMode: "stack";
}

export interface LayoutableTabParams {
  tabKind: "tab";
  layoutMode: "layoutable";
  innerLayout: unknown | null;
  activePaneId: PaneId | null;
}

export type TabParams = SimpleTabParams | StackTabParams | LayoutableTabParams;

export function isTabParams(value: unknown): value is TabParams {
  return !!value && typeof value === "object" && (value as { tabKind?: unknown }).tabKind === "tab";
}

export function isLayoutableTabParams(value: unknown): value is LayoutableTabParams {
  return isTabParams(value) && value.layoutMode === "layoutable";
}
