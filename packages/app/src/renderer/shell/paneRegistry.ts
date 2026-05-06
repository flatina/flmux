import type { CreateComponentOptions, IContentRenderer } from "dockview-core";
import type { PaneSpec, PaneStateRecord, PaneWorkspaceContext, WorkspaceStatusStore } from "@flmux/core/shell";
import { PaneRegistry as CorePaneRegistry, isTerminalPaneStateRecord } from "@flmux/core/shell";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "@flmux/core/shell/types";

export type { PaneWorkspaceContext };

export interface PaneRendererRuntimeContext {
  shellModel: ShellModelAPI;
  browserPanelTemplate: HTMLTemplateElement;
  terminalHost: Pick<TerminalHostAPI, "subscribe">;
  /** Renderer-local retained KV store shared across panes in this workspace.
   *  Renderer-only (no host-side counterpart today); extensions reach it
   *  through the facade in `external/runtime.ts` as `ctx.workspaceStatus`. */
  workspaceStatus: WorkspaceStatusStore;
  normalizeBrowserUrl(value: string): string | null;
  onBrowserUrlChange(paneId: string, url: string): void;
}

export interface PaneDescriptor<TStateRecord extends PaneStateRecord = PaneStateRecord> extends PaneSpec<TStateRecord> {
  createRenderer(args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  }): IContentRenderer;

  iconUrl?: string;
  defaultTitle?: string;
  minimumWidth?: number;
  maximumWidth?: number;
}

export class PaneRegistry extends CorePaneRegistry<PaneDescriptor> {}

export const isTerminalPaneRecord = isTerminalPaneStateRecord;
