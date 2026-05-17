import { Stream } from "bunite-core/rpc";
import type {
  FlmuxRendererBootstrapConfig,
  FlmuxSessionBootstrapResponse,
  FlmuxSessionSaveLayouts,
  SessionCapImpl
} from "../shared/rendererBridge";
import type {
  PathCallerContext,
  SequencedShellCoreEvent,
  ShellModelAPI
} from "@flmux/core/shell";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

export interface SessionImplDeps {
  /** Opaque session identity. Server-mint at bridge createSession time, baked
   *  into every method via closure. Doubles as the slot key for implicit-
   *  current narrowing in the shell model. */
  sessionId: string;
  /** ShellModel scoped to this session's user. ACL-aware. */
  shellModel: ShellModelAPI;
  /** Build the initial bootstrap snapshot (resumeToken / snapshot / layouts /
   *  seqStart). Called once per session by the renderer. */
  bootstrap(): FlmuxSessionBootstrapResponse;
  /** Renderer init config (origin / projectDir / local extensions / mode). */
  buildConfig(): FlmuxRendererBootstrapConfig;
  /** Ring-buffer replay + live forwarder. Returns null if the buffer rolled
   *  past `sinceSeq` — renderer must re-bootstrap. */
  subscribeShellEvents(sinceSeq: number, emit: (event: SequencedShellCoreEvent) => void): (() => void) | null;
  /** Pane → emit set. terminalEvents stream registers/unregisters here. */
  paneEmitters: Map<string, Set<(event: TerminalRuntimeEvent) => void>>;
  /** ACL gate for terminalEvents — deny if the pane is not owned by this
   *  session's authority. */
  canSubscribeTerminalForPane(paneId: string): boolean;
  /** Layout-save debounce hook. No-op when sessionStore isn't wired. */
  pushLayout(layouts: FlmuxSessionSaveLayouts): void;
}

export function createSessionImpl(deps: SessionImplDeps): SessionCapImpl {
  function callerCtx(extra: { sourcePaneId?: string; workspaceId?: string }): PathCallerContext {
    return {
      slotKey: deps.sessionId,
      sourcePaneId: extra.sourcePaneId,
      workspaceId: extra.workspaceId
    };
  }

  return {
    bootstrap: () => deps.bootstrap(),

    get: ({ path, sourcePaneId, workspaceId }) =>
      deps.shellModel.pathGet(path, callerCtx({ sourcePaneId, workspaceId })),

    list: ({ path, sourcePaneId, workspaceId }) =>
      deps.shellModel.pathList(path, callerCtx({ sourcePaneId, workspaceId })),

    set: ({ path, value, sourcePaneId, workspaceId }) =>
      deps.shellModel.pathSet(path, value, callerCtx({ sourcePaneId, workspaceId })),

    call: ({ path, args, sourcePaneId, workspaceId }) =>
      deps.shellModel.pathCall(path, args, callerCtx({ sourcePaneId, workspaceId })),

    events: ({ sinceSeq }) => Stream.from<SequencedShellCoreEvent>((emit, signal) => {
      const unsub = deps.subscribeShellEvents(sinceSeq ?? 0, emit);
      if (!unsub) {
        throw new Error("session.events: replay buffer overflow — renderer must re-bootstrap");
      }
      signal.addEventListener("abort", unsub);
    }),

    terminalEvents: ({ paneId }) => Stream.from<TerminalRuntimeEvent>((emit, signal) => {
      if (!deps.canSubscribeTerminalForPane(paneId)) {
        throw new Error(`terminalEvents: access denied for pane '${paneId}'`);
      }
      let emitters = deps.paneEmitters.get(paneId);
      if (!emitters) {
        emitters = new Set();
        deps.paneEmitters.set(paneId, emitters);
      }
      emitters.add(emit);
      signal.addEventListener("abort", () => {
        const set = deps.paneEmitters.get(paneId);
        if (!set) return;
        set.delete(emit);
        if (set.size === 0) deps.paneEmitters.delete(paneId);
      });
    }),

    pushLayout: (layouts) => {
      deps.pushLayout(layouts);
      return { ok: true as const };
    },

    getConfig: () => deps.buildConfig()
  };
}
