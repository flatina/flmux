import type { CreateComponentOptions, IContentRenderer } from "dockview-core";
import type { PaneSpec, PaneStateRecord, PaneWorkspaceContext } from "@flmux/core/shell";
import { PaneRegistry as CorePaneRegistry, isTerminalPaneStateRecord } from "@flmux/core/shell";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "@flmux/core/shell/types";

export type { PaneWorkspaceContext };

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
  /** Manifest-declared tab-header icon URL. When set, the per-pane
   *  hamburger button renders this in place of the default glyph. */
  iconUrl?: string;
}

export class PaneRegistry extends CorePaneRegistry<PaneDescriptor> {}

export const isTerminalPaneRecord = isTerminalPaneStateRecord;
