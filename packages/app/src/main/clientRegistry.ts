import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import type { FlmuxRendererBridge } from "../shared/rendererBridge";

/**
 * Per-client transport + lifecycle state. One entry per (desktop CEF | web
 * browser) connection to the authority. Holds the renderer bridge, the
 * ring buffer for grace-period replay, and the lifecycle timers. Survives
 * brief disconnects so seq-gated reconnect replay works.
 *
 * `clientId` is minted at HTTP `/api/shell/bootstrap` (web) or pinned to
 * `DESKTOP_CLIENT_ID = "local"` (desktop). The WS register call binds a
 * viewId to the existing clientId — no separate mint step.
 */
interface ClientState {
  readonly clientId: string;
  /** Transport view id while connected; null during grace. */
  viewId: number | null;
  /** Renderer RPC bridge. Null until `attachRenderer` runs and a viewId is
   * paired in `attachLive`. */
  bridge: FlmuxRendererBridge | null;
  /** Ring buffer of events the client would have seen if it were live.
   * Scope-filtered at push-time. Size-bounded — when
   * `lastAppliedSeq < buffer[0].seq - 1` the client must re-bootstrap. */
  readonly ringBuffer: SequencedShellCoreEvent[];
  /** Unsubscribe for the always-on buffer subscriber. Installed once per
   * client; runs regardless of live connection status. */
  unsubscribeBuffer: (() => void) | null;
  /** Unsubscribe for the live WS/preload forwarder. Set while connected,
   * cleared on disconnect. */
  unsubscribeLive: (() => void) | null;
  /** Grace-period timer. Fires → registry drops this client. */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface RegisteredFlmuxClient {
  clientId: string;
  viewId: number;
  bridge: FlmuxRendererBridge;
}

interface ClientRegistryOptions {
  /** Max events retained per client. Default 200. */
  bufferSize?: number;
  /** Grace period (ms) before a disconnected client is evicted. Default 30s. */
  graceMs?: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientState>();
  /** viewId → bridge for renderers attached before their clientId is known
   * (preload pipe / WS opens; bridge installed; later `attachLive` carries
   * the clientId from the bootstrap-supplied register call). */
  private readonly pendingBridges = new Map<number, FlmuxRendererBridge>();
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
        bridge: null,
        ringBuffer: [],
        unsubscribeBuffer: null,
        unsubscribeLive: null,
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

  pushBuffered(clientId: string, event: SequencedShellCoreEvent): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.ringBuffer.push(event);
    if (state.ringBuffer.length > this.bufferSize) {
      state.ringBuffer.shift();
    }
  }

  replayAfter(clientId: string, lastAppliedSeq: number): SequencedShellCoreEvent[] | null {
    const state = this.clients.get(clientId);
    if (!state) return null;
    if (state.ringBuffer.length === 0) return [];
    const oldest = state.ringBuffer[0]!.seq;
    if (lastAppliedSeq + 1 < oldest) return null;
    return state.ringBuffer.filter((event) => event.seq > lastAppliedSeq);
  }

  /** Bind a live transport to a client. Cancels any pending GC timer.
   * Pulls a pending bridge (`attachRenderer` may have run before the
   * clientId became known) into the client state. */
  attachLive(clientId: string, viewId: number, unsubscribeLive: () => void): void {
    const state = this.ensure(clientId);
    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }
    state.unsubscribeLive?.();
    state.unsubscribeLive = unsubscribeLive;
    state.viewId = viewId;
    const pending = this.pendingBridges.get(viewId);
    if (pending) {
      state.bridge = pending;
      this.pendingBridges.delete(viewId);
    }
  }

  setBufferSubscriber(clientId: string, unsubscribeBuffer: () => void): void {
    const state = this.ensure(clientId);
    state.unsubscribeBuffer?.();
    state.unsubscribeBuffer = unsubscribeBuffer;
  }

  /** Transport disconnected. Tears down live forwarder + bridge, then arms
   * the grace timer. Caller is the WS-close path. Safe to call when the
   * state is already unbound (no-op teardown, timer re-armed). */
  markDisconnected(clientId: string, onEvict: (state: ClientState) => void): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.unsubscribeLive?.();
    state.unsubscribeLive = null;
    state.bridge = null;
    state.viewId = null;
    this.armGraceTimer(clientId, onEvict);
  }

  /** Arm (or re-arm) the grace timer without touching live state. Used by
   * the HTTP bootstrap re-entry path: it expects the client to already be
   * unbound (browser closed WS before re-bootstrapping). Guards against a
   * silent live-WS teardown if the precondition is ever violated. */
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
    state.unsubscribeBuffer?.();
    state.unsubscribeLive?.();
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    this.clients.delete(clientId);
  }

  /** Enumerate live clients (viewId set). For broadcast fan-out. */
  liveClients(): ClientState[] {
    return [...this.clients.values()].filter((state) => state.viewId !== null);
  }

  // ── Renderer bridge tracking ──

  /** Install the renderer bridge for a transport. Called when the preload
   * pipe / WS opens, before the register call carries the clientId.
   * The bridge is attached to the client state on `attachLive`. */
  attachRenderer(viewId: number, bridge: FlmuxRendererBridge): void {
    const existing = this.resolveByViewId(viewId);
    if (existing) {
      existing.bridge = bridge;
      return;
    }
    this.pendingBridges.set(viewId, bridge);
  }

  /** Bind a viewId to an existing clientId (minted at bootstrap). Pulls a
   * pending bridge into the client state. Called from the router's
   * `registerClient` when the WS register call carries the clientId.
   * `attachLive` is called separately to install the live forwarder. */
  bindClient(viewId: number, clientId: string): RegisteredFlmuxClient {
    const state = this.ensure(clientId);
    state.viewId = viewId;
    const pending = this.pendingBridges.get(viewId);
    if (pending) {
      state.bridge = pending;
      this.pendingBridges.delete(viewId);
    }
    if (!state.bridge) {
      throw new Error(`No renderer bridge for viewId=${viewId} (clientId=${clientId})`);
    }
    return { clientId, viewId, bridge: state.bridge };
  }

  /** Resolve a connected client by clientId. Throws when unknown — callers
   * surface the error to the CLI. */
  resolve(clientId: string): RegisteredFlmuxClient {
    const state = this.clients.get(clientId);
    if (!state || state.viewId === null || !state.bridge) {
      throw new Error(`Unknown flmux client: ${clientId}`);
    }
    return { clientId, viewId: state.viewId, bridge: state.bridge };
  }

  /** Resolve a connected client by viewId. Returns null when no client is
   * bound to that viewId yet (still pending) or has gone live without a
   * bridge. */
  resolveRendererByViewId(viewId: number): RegisteredFlmuxClient | null {
    const state = this.resolveByViewId(viewId);
    if (!state || !state.bridge) return null;
    return { clientId: state.clientId, viewId, bridge: state.bridge };
  }

  /** All connected clients (with bridge + viewId). For `/api/clients`. */
  list(): RegisteredFlmuxClient[] {
    return [...this.clients.values()]
      .filter((state): state is ClientState & { viewId: number; bridge: FlmuxRendererBridge } =>
        state.viewId !== null && state.bridge !== null
      )
      .map((state) => ({ clientId: state.clientId, viewId: state.viewId, bridge: state.bridge }));
  }

  /** Drop a renderer bridge (transport gone). Does NOT evict the client —
   * `markDisconnected` handles grace + eviction; this just clears bridge
   * state synchronously. */
  detachRenderer(viewId: number): void {
    this.pendingBridges.delete(viewId);
    const state = this.resolveByViewId(viewId);
    if (state) {
      state.bridge = null;
      state.viewId = null;
    }
  }
}
