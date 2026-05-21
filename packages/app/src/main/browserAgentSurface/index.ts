import { ModelPathError, type SequencedShellCoreEvent, type ShellCore } from "@flmux/core/shell";
import type { AuthorityBrowserPaneController } from "../browserPaneController";
import { PaneState, type CreatePopupPaneFn } from "./paneState";
import { AGENT_OPS, dispatchAgentOp } from "./ops";

export { PaneState } from "./paneState";
export { RefRegistry, type RefEntry, type RefSignature } from "./refRegistry";
export { SurfaceEventBus } from "./surfaceEventBus";
export {
  parseTarget,
  resolveTarget,
  type Target,
  type ResolvedTarget
} from "./targetResolver";
export { AGENT_OPS } from "./ops";

export class BrowserAgentSurface {
  private panes = new Map<string, PaneState>();
  private paneWorkspace = new Map<string, string>();
  private shellUnsub: (() => void) | null = null;
  private connUnsub: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly shellCore: ShellCore,
    private readonly controller: AuthorityBrowserPaneController
  ) {
    this.shellUnsub = shellCore.subscribe((event) => this.onShellEvent(event));
    this.connUnsub = controller.onConnectionChanged((conn) => {
      for (const ps of this.panes.values()) void ps.onConnectionChanged(conn);
    });
  }

  private createPopupPane: CreatePopupPaneFn = async ({ openerPaneId, newSurfaceId, url }) => {
    const workspaceId = this.paneWorkspace.get(openerPaneId);
    if (!workspaceId) return null;
    const created = await this.shellCore.createPane(
      {
        kind: "browser",
        url,
        params: { url, adoptPopupId: newSurfaceId },
        place: "right",
        referencePaneId: openerPaneId
      },
      { workspaceId }
    );
    return { paneId: created.id };
  };

  paneState(paneId: string): PaneState | undefined {
    return this.panes.get(paneId);
  }

  requirePane(paneId: string): PaneState {
    const ps = this.panes.get(paneId);
    if (!ps) throw new ModelPathError("NOT_FOUND", `no browser pane state for '${paneId}'`);
    return ps;
  }

  handles(op: string): boolean {
    return AGENT_OPS.has(op);
  }

  async call(paneId: string, op: string, args: Record<string, unknown>): Promise<{ value: unknown }> {
    const state = this.requirePane(paneId);
    await state.start();
    const cap = await this.controller.primCap();
    const result = await dispatchAgentOp(op, cap, paneId, state, args);
    if (op === "click" || op === "dblclick" || op === "press" || op === "type") {
      const adoptions = state.drainRecentAdoptions();
      if (adoptions.length > 0) {
        const v = result.value;
        return {
          value: typeof v === "object" && v !== null
            ? { ...(v as Record<string, unknown>), newPanes: adoptions }
            : { result: v, newPanes: adoptions }
        };
      }
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shellUnsub?.();
    this.connUnsub?.();
    for (const ps of this.panes.values()) ps.dispose();
    this.panes.clear();
  }

  private onShellEvent(event: SequencedShellCoreEvent): void {
    if (event.topic === "pane.added") {
      const { paneId, workspaceId, snapshot } = event.payload as {
        paneId: string;
        workspaceId: string;
        snapshot: { kind: string };
      };
      this.paneWorkspace.set(paneId, workspaceId);
      if (snapshot.kind !== "browser") return;
      if (this.panes.has(paneId)) return;
      const state = new PaneState(paneId, this.controller, this.createPopupPane);
      this.panes.set(paneId, state);
      void state.start();
    } else if (event.topic === "pane.removed") {
      const { paneId } = event.payload as { paneId: string };
      this.paneWorkspace.delete(paneId);
      const state = this.panes.get(paneId);
      if (state) {
        state.dispose();
        this.panes.delete(paneId);
      }
    }
  }
}
