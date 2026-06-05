import type { SequencedShellCoreEvent } from "@flmux/core/shell";

export type ShellEventEmitter = (event: SequencedShellCoreEvent) => void;

/**
 * Per-client state. One entry per (desktop CEF | web browser) connection to
 * the authority. Holds the ring buffer, live event emitters (shell stream
 * consumers), and grace timer. Survives brief disconnects so seq-gated
 * reconnect replay works.
 *
 * `clientId` is minted at HTTP `/api/shell/bootstrap` (web) or pinned to
 * `DESKTOP_CLIENT_ID = "local"` (desktop). The WS register call binds a
 * viewId to the existing clientId — no separate mint step.
 */
interface ClientState {
  readonly clientId: string;
  /** Transport view id while connected; null during grace. */
  viewId: number | null;
  /** Ring buffer of events the client would have seen if it were live.
   * Scope- and read-ACL-filtered upstream at push-time (`main.ts` per-client
   * subscriber), so reconnect replay respects the ACL. Size-bounded — when
   * `lastAppliedSeq < buffer[0].seq - 1` the client must re-bootstrap. */
  readonly ringBuffer: SequencedShellCoreEvent[];
  /** Live `shell.events()` stream emitters. Each open stream registers one
   * here via `subscribeLive`; abort/cancel removes it. */
  readonly liveEmitters: Set<ShellEventEmitter>;
  /** Unsubscribe for the authority subscriber that feeds this client's
   * buffer + liveEmitters. Installed once per client; runs regardless of
   * live connection status. */
  unsubscribeAuthoritySub: (() => void) | null;
  /** Grace-period timer. Fires → registry drops this client. */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface RegisteredFlmuxClient {
  clientId: string;
  viewId: number;
}

interface ClientRegistryOptions {
  /** Max events retained per client. Default 200. */
  bufferSize?: number;
  /** Grace period (ms) before a disconnected client is evicted. Default 30s. */
  graceMs?: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientState>();
  private readonly bufferSize: number;
  private readonly graceMs: number;

  constructor(options: ClientRegistryOptions = {}) {
    this.bufferSize = options.bufferSize ?? 200;
    this.graceMs = options.graceMs ?? 30_000;
  }

  ensure(clientId: string): ClientState {
    let state = this.clients.get(clientId);
    if (!state) {
      state = {
        clientId,
        viewId: null,
        ringBuffer: [],
        liveEmitters: new Set(),
        unsubscribeAuthoritySub: null,
        disconnectTimer: null
      };
      this.clients.set(clientId, state);
    }
    return state;
  }

  get(clientId: string): ClientState | undefined {
    return this.clients.get(clientId);
  }

  resolveByViewId(viewId: number): ClientState | undefined {
    for (const state of this.clients.values()) {
      if (state.viewId === viewId) return state;
    }
    return undefined;
  }

  /** Authority subscriber pushes here; ring-buffers the event and fans to
   * every live shell.events() stream emitter for this client. */
  recordEvent(clientId: string, event: SequencedShellCoreEvent): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.ringBuffer.push(event);
    if (state.ringBuffer.length > this.bufferSize) state.ringBuffer.shift();
    for (const emit of state.liveEmitters) {
      try {
        emit(event);
      } catch {
        /* stream consumer threw — drop, the bunite stream layer handles cleanup on next abort */
      }
    }
  }

  /** Return all buffered events with seq > sinceSeq, or null if the buffer
   * rolled past the client's last-applied seq (caller must re-bootstrap). */
  replayAfter(clientId: string, lastAppliedSeq: number): SequencedShellCoreEvent[] | null {
    const state = this.clients.get(clientId);
    if (!state) return null;
    if (state.ringBuffer.length === 0) return [];
    const oldest = state.ringBuffer[0]!.seq;
    if (lastAppliedSeq + 1 < oldest) return null;
    return state.ringBuffer.filter((event) => event.seq > lastAppliedSeq);
  }

  /** Register a live emitter for `shell.events()`. Returns unsubscribe. */
  subscribeLive(clientId: string, emit: ShellEventEmitter): () => void {
    const state = this.ensure(clientId);
    state.liveEmitters.add(emit);
    return () => {
      state.liveEmitters.delete(emit);
    };
  }

  /** Bind a live transport to a client. Cancels any pending grace timer. */
  attachLive(clientId: string, viewId: number): void {
    const state = this.ensure(clientId);
    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }
    state.viewId = viewId;
  }

  setAuthoritySubscriber(clientId: string, unsubscribe: () => void): void {
    const state = this.ensure(clientId);
    state.unsubscribeAuthoritySub?.();
    state.unsubscribeAuthoritySub = unsubscribe;
  }

  /** Transport disconnected. Live emitters are typically cleared by their
   * own stream-abort paths (bunite closes streams on connection close); we
   * clear the Set defensively in case a stream lingered. */
  markDisconnected(clientId: string, onEvict: (state: ClientState) => void): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.liveEmitters.clear();
    state.viewId = null;
    this.armGraceTimer(clientId, onEvict);
  }

  armGraceTimer(clientId: string, onEvict: (state: ClientState) => void): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    if (state.viewId !== null) {
      throw new Error(`armGraceTimer: client '${clientId}' is still live (viewId=${state.viewId})`);
    }
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    state.disconnectTimer = setTimeout(() => {
      this.evict(clientId);
      onEvict(state);
    }, this.graceMs);
  }

  evict(clientId: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.unsubscribeAuthoritySub?.();
    state.liveEmitters.clear();
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    this.clients.delete(clientId);
  }

  liveClients(): ClientState[] {
    return [...this.clients.values()].filter((state) => state.viewId !== null);
  }

  resolve(clientId: string): RegisteredFlmuxClient {
    const state = this.clients.get(clientId);
    if (!state || state.viewId === null) throw new Error(`Unknown flmux client: ${clientId}`);
    return { clientId, viewId: state.viewId };
  }

  resolveRendererByViewId(viewId: number): RegisteredFlmuxClient | null {
    const state = this.resolveByViewId(viewId);
    if (!state) return null;
    return { clientId: state.clientId, viewId };
  }

  list(): RegisteredFlmuxClient[] {
    return [...this.clients.values()]
      .filter((state): state is ClientState & { viewId: number } => state.viewId !== null)
      .map((state) => ({ clientId: state.clientId, viewId: state.viewId }));
  }

  detachRenderer(viewId: number): void {
    const state = this.resolveByViewId(viewId);
    if (state) {
      state.viewId = null;
      state.liveEmitters.clear();
    }
  }
}
