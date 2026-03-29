import type { PaneId } from "../../lib/ids";
import { isPaneParams, type PaneParams } from "./pane-params";

export type { LayoutMode } from "../../types/view";

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
  customTitle?: string | null;
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
