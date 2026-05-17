import type { CallCtx, Connection, ExportedCap } from "bunite-core/rpc";
import { flmuxBridgeCap, sessionCap, type FlmuxBridgeCapImpl } from "../shared/rendererBridge";
import type { SessionCapImpl } from "../shared/rendererBridge";

export interface MintedSession {
  sessionId: string;
  sessionImpl: SessionCapImpl;
  /** Run when the connection closes — releases authority/registry/lifecycle state. */
  dispose(): void;
}

export interface BridgeImplDeps {
  connection: Connection;
  mintSession(): Promise<MintedSession>;
  /** `minted.sessionId` MUST equal `resumeToken` — slotKey continuity depends on it. */
  resumeSession(resumeToken: string): Promise<MintedSession | null>;
}

export function createBridgeImpl(deps: BridgeImplDeps): FlmuxBridgeCapImpl {
  let active = false;
  let inflight: Promise<unknown> | null = null;

  async function withSerialBind<R>(work: (ctx: CallCtx) => Promise<R>, ctx: CallCtx): Promise<R> {
    // Serialize so concurrent createSession/resumeSession on one connection
    // can't both run their mint side-effects (bindClientTransport / serve
    // ext caps) before the `active` guard fires.
    while (inflight) {
      try { await inflight; } catch { /* swallow — next caller re-checks `active` */ }
    }
    if (active) throw new Error("bridge: session already established on this connection");
    const promise = (async () => {
      if (active) throw new Error("bridge: session already established on this connection");
      if (deps.connection.closed) throw new Error("bridge: connection closed before bind");
      return work(ctx);
    })();
    inflight = promise;
    try {
      return await promise;
    } finally {
      inflight = null;
    }
  }

  function bind(minted: MintedSession, ctx: CallCtx): ExportedCap<typeof sessionCap> {
    if (deps.connection.closed) {
      minted.dispose();
      throw new Error("bridge: connection closed before bind");
    }
    const exported = ctx.exportCap(sessionCap, minted.sessionImpl);
    active = true;
    deps.connection.onClose(() => { minted.dispose(); });
    return exported;
  }

  return {
    createSession: (_args, ctx) =>
      withSerialBind(async (callCtx) => bind(await deps.mintSession(), callCtx), ctx),

    resumeSession: ({ resumeToken }, ctx) =>
      withSerialBind(async (callCtx) => {
        const minted = await deps.resumeSession(resumeToken);
        if (!minted) throw new Error("bridge.resumeSession: unknown or expired token");
        if (minted.sessionId !== resumeToken) {
          minted.dispose();
          throw new Error("bridge.resumeSession: minted sessionId must equal resumeToken");
        }
        return bind(minted, callCtx);
      }, ctx),

    createDesktopSession: (_args, ctx) => {
      if (ctx.attestation.level !== "app-internal") {
        throw new Error("bridge.createDesktopSession: preload attestation required");
      }
      return withSerialBind(async (callCtx) => bind(await deps.mintSession(), callCtx), ctx);
    }
  };
}

export { flmuxBridgeCap };
