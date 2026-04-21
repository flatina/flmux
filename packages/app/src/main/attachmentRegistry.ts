import type { SequencedShellCoreEvent } from "@flmux/core/shell";

/**
 * Per-attachment transport state. One entry per (desktop CEF | web browser)
 * connection to the authority. The registry keeps the entry alive across
 * brief disconnects (grace period) so seq-gated reconnect replay works.
 *
 * B1c scope: infrastructure + desktop path (single `"local"` attachment).
 * B1d wires browser attachments + the HTTP /api/shell/bootstrap + WS
 * lastAppliedSeq handshake that actually exercises the ring buffer.
 */
export interface AttachmentState {
  readonly attachmentId: string;
  /** Transport view id while the client is connected; null during grace. */
  viewId: number | null;
  /** Ring buffer of events the attachment would have seen if it were live.
   * Scope-filtered at push-time so we never store events intended for other
   * attachments. Size-bounded — when `lastAppliedSeq < buffer[0].seq - 1`
   * the client must re-bootstrap. */
  readonly ringBuffer: SequencedShellCoreEvent[];
  /** Unsubscribe for the always-on buffer subscriber. Installed once per
   * attachment; runs regardless of live connection status. */
  unsubscribeBuffer: (() => void) | null;
  /** Unsubscribe for the live WS/preload forwarder. Set while connected,
   * cleared on disconnect. */
  unsubscribeLive: (() => void) | null;
  /** Grace-period timer. Fires → registry drops this attachment. */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface AttachmentRegistryOptions {
  /** Max events retained per attachment. B1c default 200 per preflight #3. */
  bufferSize?: number;
  /** Grace period (ms) before a disconnected attachment is evicted. */
  graceMs?: number;
}

export class AttachmentRegistry {
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly bufferSize: number;
  private readonly graceMs: number;

  constructor(options: AttachmentRegistryOptions = {}) {
    this.bufferSize = options.bufferSize ?? 200;
    this.graceMs = options.graceMs ?? 30_000;
  }

  /** Create an entry if missing; otherwise return the existing one unchanged. */
  ensure(attachmentId: string): AttachmentState {
    let state = this.attachments.get(attachmentId);
    if (!state) {
      state = {
        attachmentId,
        viewId: null,
        ringBuffer: [],
        unsubscribeBuffer: null,
        unsubscribeLive: null,
        disconnectTimer: null
      };
      this.attachments.set(attachmentId, state);
    }
    return state;
  }

  get(attachmentId: string): AttachmentState | undefined {
    return this.attachments.get(attachmentId);
  }

  resolveByViewId(viewId: number): AttachmentState | undefined {
    for (const state of this.attachments.values()) {
      if (state.viewId === viewId) return state;
    }
    return undefined;
  }

  /** Push an event into the attachment's ring buffer; drop oldest if over cap. */
  pushBuffered(attachmentId: string, event: SequencedShellCoreEvent): void {
    const state = this.attachments.get(attachmentId);
    if (!state) return;
    state.ringBuffer.push(event);
    if (state.ringBuffer.length > this.bufferSize) {
      state.ringBuffer.shift();
    }
  }

  /**
   * Replay events after `lastAppliedSeq`. Returns null when the client's
   * position is older than the buffer's oldest event — caller should respond
   * with a rebootstrap-required signal.
   */
  replayAfter(attachmentId: string, lastAppliedSeq: number): SequencedShellCoreEvent[] | null {
    const state = this.attachments.get(attachmentId);
    if (!state) return null;
    if (state.ringBuffer.length === 0) {
      // No buffered events. Trivially "replay returns nothing" — live stream
      // will carry everything going forward.
      return [];
    }
    const oldest = state.ringBuffer[0]!.seq;
    if (lastAppliedSeq + 1 < oldest) {
      // We don't hold the missing seq range any more.
      return null;
    }
    return state.ringBuffer.filter((event) => event.seq > lastAppliedSeq);
  }

  /** Bind a live transport to an attachment. Cancels any pending GC timer. */
  attachLive(attachmentId: string, viewId: number, unsubscribeLive: () => void): void {
    const state = this.ensure(attachmentId);
    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }
    // Tear down any prior live subscriber before replacing — prevents double
    // delivery if attachLive is called twice without an intervening detach.
    state.unsubscribeLive?.();
    state.unsubscribeLive = unsubscribeLive;
    state.viewId = viewId;
  }

  /** Record the always-on buffer subscriber so the registry can release it. */
  setBufferSubscriber(attachmentId: string, unsubscribeBuffer: () => void): void {
    const state = this.ensure(attachmentId);
    state.unsubscribeBuffer?.();
    state.unsubscribeBuffer = unsubscribeBuffer;
  }

  /**
   * Called when a transport disconnects. Keeps the buffer subscriber alive
   * through the grace period so events during the gap are buffered for a
   * reconnecting client. Schedules eviction when grace expires.
   */
  markDisconnected(attachmentId: string, onEvict: (state: AttachmentState) => void): void {
    const state = this.attachments.get(attachmentId);
    if (!state) return;
    state.unsubscribeLive?.();
    state.unsubscribeLive = null;
    state.viewId = null;
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    state.disconnectTimer = setTimeout(() => {
      this.evict(attachmentId);
      onEvict(state);
    }, this.graceMs);
  }

  /** Drop an attachment immediately (called from eviction timer or shutdown). */
  evict(attachmentId: string): void {
    const state = this.attachments.get(attachmentId);
    if (!state) return;
    state.unsubscribeBuffer?.();
    state.unsubscribeLive?.();
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    this.attachments.delete(attachmentId);
  }

  /** Enumerate live attachments (viewId set). For broadcast fan-out. */
  liveAttachments(): AttachmentState[] {
    return [...this.attachments.values()].filter((state) => state.viewId !== null);
  }
}
