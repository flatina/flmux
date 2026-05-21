import type { Connection } from "bunite-core/rpc";
import type { AuthorityBrowserPaneController } from "../browserPaneController";
import type {
  BrowserPaneCapabilities,
  BrowserPaneDialogEvent,
  BrowserPaneSurfaceEvent
} from "../../shared/rendererBridge";
import { RefRegistry } from "./refRegistry";
import { SurfaceEventBus } from "./surfaceEventBus";

export interface Waiter {
  cancel(reason: string): void;
}

export interface AdoptionState {
  paneId: string;
  openerPaneId: string;
  url: string;
  startedAt: number;
}

const CAPS_TTL_MS = 30_000;

export class PaneState {
  readonly refRegistry = new RefRegistry();
  readonly surfaceEventBus = new SurfaceEventBus();
  readonly pendingWaiters = new Map<string, Waiter>();
  readonly pendingPopupAdoptions = new Map<number, AdoptionState>();
  /** Latest pending dialog (alert/confirm/prompt) — agent's `dialog accept`
   * / `dialog dismiss` responds to this. Cleared on response or auto-dismiss. */
  pendingDialog: { requestId: number; kind: string; message: string } | null = null;
  private dialogStreamAbort: AbortController | null = null;

  private capabilities: BrowserPaneCapabilities | null = null;
  private capabilitiesFetchedAt = 0;
  private capabilitiesFetch: Promise<BrowserPaneCapabilities> | null = null;
  private startStarted = false;
  private disposed = false;

  constructor(readonly paneId: string, private readonly controller: AuthorityBrowserPaneController) {
    // navigate arm → soft invalidate (revalidation handled at resolve time
    // via snapshotEpoch comparison); load-finish epoch > captured → hard
    // invalidate (registry cleared).
    this.surfaceEventBus.on(this.onSurfaceEvent);
  }

  private onSurfaceEvent = (e: BrowserPaneSurfaceEvent) => {
    if (e.type === "load-finish") {
      // Hard invalidate: page fully reloaded — all refs gone.
      this.refRegistry.clear();
    }
  };

  async start(): Promise<void> {
    if (this.startStarted || this.disposed) return;
    this.startStarted = true;
    try {
      const cap = await this.controller.primCap();
      await this.surfaceEventBus.start(cap, this.paneId);
      this.startDialogTracking(cap);
    } catch {
      // surface not ready yet — onConnectionChanged will retry on rebind.
    }
  }

  private startDialogTracking(cap: Awaited<ReturnType<AuthorityBrowserPaneController["primCap"]>>) {
    this.dialogStreamAbort?.abort();
    const abort = new AbortController();
    this.dialogStreamAbort = abort;
    void (async () => {
      try {
        const stream = cap.dialogs({ paneId: this.paneId });
        for await (const event of stream as AsyncIterable<BrowserPaneDialogEvent>) {
          if (abort.signal.aborted) break;
          if (event.kind === "auto-dismissed") {
            this.pendingDialog = null;
          } else {
            this.pendingDialog = {
              requestId: event.requestId,
              kind: event.kind,
              message: event.message
            };
          }
        }
      } catch {}
    })();
  }

  async onConnectionChanged(conn: Connection | null): Promise<void> {
    if (this.disposed) return;
    if (!conn) {
      this.surfaceEventBus.pause();
      this.capabilities = null;
      this.capabilitiesFetchedAt = 0;
      return;
    }
    try {
      const cap = await this.controller.primCap();
      await this.surfaceEventBus.restart(cap, this.paneId);
      // Engine may have changed (WV2↔CEF) — invalidate cached caps.
      this.capabilities = null;
      this.capabilitiesFetchedAt = 0;
    } catch {
      /* not ready */
    }
  }

  async getCapabilities(): Promise<BrowserPaneCapabilities> {
    if (this.capabilities && Date.now() - this.capabilitiesFetchedAt < CAPS_TTL_MS) {
      return this.capabilities;
    }
    if (!this.capabilitiesFetch) {
      this.capabilitiesFetch = (async () => {
        const cap = await this.controller.primCap();
        const caps = await cap.capabilities({ paneId: this.paneId });
        this.capabilities = caps;
        this.capabilitiesFetchedAt = Date.now();
        return caps;
      })().finally(() => {
        this.capabilitiesFetch = null;
      });
    }
    return this.capabilitiesFetch;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dialogStreamAbort?.abort();
    this.surfaceEventBus.dispose();
    for (const w of this.pendingWaiters.values()) w.cancel("pane removed");
    this.pendingWaiters.clear();
    this.pendingPopupAdoptions.clear();
    this.refRegistry.clear();
    this.pendingDialog = null;
  }
}
