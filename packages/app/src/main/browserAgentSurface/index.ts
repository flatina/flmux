import { ModelPathError, type SequencedShellCoreEvent, type ShellCore } from "@flmux/core/shell";
import type { AuthorityBrowserPaneController } from "../browserPaneController";
import { PaneState } from "./paneState";
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

/** Per-authority agent surface. Lifecycle = authority lifecycle. Listens to
 * shell pane.added/removed, holds a `PaneState` per browser pane. */
export class BrowserAgentSurface {
  private panes = new Map<string, PaneState>();
  private shellUnsub: (() => void) | null = null;
  private connUnsub: (() => void) | null = null;
  private disposed = false;

  constructor(shellCore: ShellCore, private readonly controller: AuthorityBrowserPaneController) {
    this.shellUnsub = shellCore.subscribe((event) => this.onShellEvent(event));
    this.connUnsub = controller.onConnectionChanged((conn) => {
      for (const ps of this.panes.values()) void ps.onConnectionChanged(conn);
    });
  }

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
    const cap = await this.controller.primCap();
    return await dispatchAgentOp(op, cap, paneId, state, args);
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
      const { paneId, snapshot } = event.payload as { paneId: string; snapshot: { kind: string } };
      if (snapshot.kind !== "browser") return;
      if (this.panes.has(paneId)) return;
      const state = new PaneState(paneId, this.controller);
      this.panes.set(paneId, state);
      void state.start();
    } else if (event.topic === "pane.removed") {
      const { paneId } = event.payload as { paneId: string };
      const state = this.panes.get(paneId);
      if (state) {
        state.dispose();
        this.panes.delete(paneId);
      }
    }
  }
}
