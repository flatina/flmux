import type { PaneId } from "./ids";
import { isPaneParams, type PaneParams } from "./pane-params";

export type LayoutMode = "simple" | "stack" | "layoutable";

export type SimpleTabParams = {
  tabKind: "tab";
  layoutMode: "simple";
} & PaneParams;

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

export function isSimpleTabParams(value: unknown): value is SimpleTabParams {
  return isTabParams(value) && value.layoutMode === "simple" && isPaneParams(value);
}

export function createSimpleTabParams(params: PaneParams): SimpleTabParams {
  return {
    tabKind: "tab",
    layoutMode: "simple",
    ...params
  };
}
