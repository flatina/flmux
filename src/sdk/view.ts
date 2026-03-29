export type {
  AppProps, WorkspaceProps, PaneProps,
  ThemePreference, ResolvedTheme, AppPropKey, WorkspacePropKey, PanePropKey,
  LayoutMode, PropsByScope, PropScope, ViewKey,
  ScopeListener, ScopeEmitter,
  App, Workspace, Pane,
  HeaderAction,
  PaneSummaryBase, WorkspaceSummaryBase, AppSummaryBase,
  Context, FlmuxViewInstance, FlmuxView
} from "../types/view";

export type { PaneOpenOptions } from "../types/setup";

// Backwards-compatible aliases for View-prefixed names (extensions may use these)
export type {
  PropScope as ViewPropScope,
  PropsByScope as ViewPropsByScope,
  ScopeListener as ViewEventListener,
  ScopeEmitter as ViewEventEmitter,
  App as ViewApp,
  Workspace as ViewWorkspace,
  Pane as ViewPane,
  Context as ViewContext,
  PaneSummaryBase as ViewPaneSummary,
  WorkspaceSummaryBase as ViewTabSummary,
  AppSummaryBase as ViewAppSummary
} from "../types/view";

export type {
  PropertyScope, PropertyValueType, PropertyMetadata, PropertyInfo, PropertyHandle, PropertyChangeEvent,
  PropertyValueType as ViewPropertyValueType,
  PropertyMetadata as ViewPropertyMetadata,
  PropertyInfo as ViewPropertyInfo,
  PropertyHandle as ViewPropertyHandle
} from "../types/property";

import type { FlmuxView, ViewKey } from "../types/view";

export function createViewKey(extensionId: string, viewId: string): ViewKey {
  return `${extensionId}:${viewId}`;
}

export function parseViewKey(viewKey: ViewKey): { extensionId: string; viewId: string } | null {
  const idx = viewKey.indexOf(":");
  if (idx <= 0 || idx === viewKey.length - 1) return null;
  return { extensionId: viewKey.slice(0, idx), viewId: viewKey.slice(idx + 1) };
}

export function defineView<Params = Record<string, never>, State extends object = Record<string, never>>(
  view: FlmuxView<Params, State>
): FlmuxView<Params, State> {
  return view;
}
