import type { BrowserPaneSurfaceEvent, PaneBrowserCap } from "../../shared/rendererBridge";

type Listener = (e: BrowserPaneSurfaceEvent) => void;
type StreamHandle = { cancel?: () => void };

/** Per-pane fan-out of bunite surfaceEvents stream. flmux holds 1
 * subscription, multi-consumer set. Restart on connection rebind with
 * epoch-based replay so missed `load-finish` resurfaces. */
export class SurfaceEventBus {
  private listeners = new Set<Listener>();
  private stream: StreamHandle | null = null;
  private iteratorAbort: AbortController | null = null;
  private lastSeenEpoch = 0;
  private disposed = false;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get latestEpoch(): number {
    return this.lastSeenEpoch;
  }

  async start(cap: PaneBrowserCap, paneId: string): Promise<void> {
    if (this.disposed) return;
    this.pause();
    const stream = cap.surfaceEvents({ paneId });
    this.stream = stream as StreamHandle;
    const abort = new AbortController();
    this.iteratorAbort = abort;
    void (async () => {
      try {
        for await (const event of stream as AsyncIterable<BrowserPaneSurfaceEvent>) {
          if (abort.signal.aborted) break;
          this.lastSeenEpoch = event.epoch;
          for (const fn of this.listeners) {
            try {
              fn(event);
            } catch {
              /* listener errors don't tear down the bus */
            }
          }
        }
      } catch {
        /* stream torn — restart() on conn rebind covers */
      }
    })();
  }

  /** Reconnect path — cancel old stream, start fresh, then synthesize a
   * `load-finish` if NavigationState advanced past `lastSeenEpoch`. */
  async restart(cap: PaneBrowserCap, paneId: string): Promise<void> {
    const previousEpoch = this.lastSeenEpoch;
    await this.start(cap, paneId);
    try {
      const nav = await cap.getNavigationState({ paneId });
      if (nav.lastLoadEpoch > previousEpoch) {
        const synthetic: BrowserPaneSurfaceEvent = {
          type: "load-finish",
          epoch: nav.lastLoadEpoch,
          url: nav.currentUrl
        };
        this.lastSeenEpoch = nav.lastLoadEpoch;
        for (const fn of this.listeners) {
          try {
            fn(synthetic);
          } catch {}
        }
      }
    } catch {
      /* getNavigationState failure not fatal */
    }
  }

  pause(): void {
    this.iteratorAbort?.abort();
    this.iteratorAbort = null;
    this.stream?.cancel?.();
    this.stream = null;
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.listeners.clear();
  }
}
