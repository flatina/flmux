import type { CreateComponentOptions, IContentRenderer } from "dockview-core";
import type { PaneSpec, PaneStateRecord, PaneWorkspaceContext, WorkspaceStatusStore } from "@flmux/core/shell";
import { PaneRegistry as CorePaneRegistry, isTerminalPaneStateRecord } from "@flmux/core/shell";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

export type { PaneWorkspaceContext };

export interface PaneRendererRuntimeContext {
  shellModel: ShellModelAPI;
  browserPanelTemplate: HTMLTemplateElement;
  /** Opens a per-pane `shell.terminalEvents({paneId})` stream and routes
   *  events to `handler`. Returns unsubscribe; stream cancel on the bunite
   *  side fires too. */
  subscribeTerminalEvents(paneId: string, handler: (event: TerminalRuntimeEvent) => void): () => void;
  /** Renderer-local retained KV store shared across panes in this workspace.
   *  Renderer-only (no host-side counterpart today); extensions reach it
   *  through the facade in `external/runtime.ts` as `ctx.workspaceStatus`. */
  workspaceStatus: WorkspaceStatusStore;
  normalizeBrowserUrl(value: string): string | null;
  onBrowserUrlChange(paneId: string, url: string): void;
  /** Label for the explorer header (web: signed-in user; desktop: project name). */
  userLabel: string;
  /** Web mode → folder upload affordance is available (`/api/fs/upload`). */
  canUpload: boolean;
}

export interface PaneDescriptor<TStateRecord extends PaneStateRecord = PaneStateRecord> extends PaneSpec<TStateRecord> {
  createRenderer(args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  }): IContentRenderer;

  iconUrl?: string;
  defaultTitle?: string;
  minimumSize?: number;
  maximumSize?: number;
  initialSize?: number;
}

export class PaneRegistry extends CorePaneRegistry<PaneDescriptor> {}

export const isTerminalPaneRecord = isTerminalPaneStateRecord;
