import type { CreateComponentOptions, IContentRenderer } from "dockview-core";
import type {
  PaneLifecycleHooks,
  PanePathMount,
  PanePathMountContext,
  PanePersistenceHooks,
  PaneSpec,
  PaneStateRecord,
  PaneSubtreeMount,
  PaneWorkspaceContext
} from "@flmux/core/shell";
import {
  PaneRegistry as CorePaneRegistry,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord
} from "@flmux/core/shell";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "./types";

export type {
  PaneWorkspaceContext,
  PaneLifecycleHooks,
  PanePersistenceHooks,
  PanePathMountContext,
  PanePathMount,
  PaneSubtreeMount
};

export interface PaneRendererRuntimeContext {
  shellModel: ShellModelAPI;
  browserPanelTemplate: HTMLTemplateElement;
  terminalHost: Pick<TerminalHostAPI, "subscribe">;
  normalizeBrowserUrl(value: string): string | null;
  onBrowserUrlChange(paneId: string, url: string): void;
}

export interface PaneDescriptor<TStateRecord extends PaneStateRecord = PaneStateRecord> extends PaneSpec<TStateRecord> {
  createRenderer(args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  }): IContentRenderer;
}

export class PaneRegistry extends CorePaneRegistry<PaneDescriptor> {}

export const isBrowserPaneRecord = isBrowserPaneStateRecord;
export const isTerminalPaneRecord = isTerminalPaneStateRecord;
