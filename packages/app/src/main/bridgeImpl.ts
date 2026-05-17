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

  function bind(minted: MintedSession, ctx: CallCtx): ExportedCap<typeof sessionCap> {
    if (active) {
      minted.dispose();
      throw new Error("bridge: session already established on this connection");
    }
    if (deps.connection.closed) {
      minted.dispose();
      throw new Error("bridge: connection closed before bind");
    }
    const exported = ctx.exportCap(sessionCap, minted.sessionImpl);
    active = true;
    deps.connection.onClose(() => {
      minted.dispose();
    });
    return exported;
  }

  return {
    createSession: async (_args, ctx) => bind(await deps.mintSession(), ctx),

    resumeSession: async ({ resumeToken }, ctx) => {
      const minted = await deps.resumeSession(resumeToken);
      if (!minted) throw new Error("bridge.resumeSession: unknown or expired token");
      if (minted.sessionId !== resumeToken) {
        minted.dispose();
        throw new Error("bridge.resumeSession: minted sessionId must equal resumeToken");
      }
      return bind(minted, ctx);
    },

    createDesktopSession: async (_args, ctx) => {
      if (ctx.attestation.level !== "app-internal") {
        throw new Error("bridge.createDesktopSession: preload attestation required");
      }
      return bind(await deps.mintSession(), ctx);
    }
  };
}

export { flmuxBridgeCap };
