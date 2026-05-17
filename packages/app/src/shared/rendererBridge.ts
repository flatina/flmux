import { call, cap, defineCap, stream } from "bunite-core/rpc";
import type { ClientOf, ImplOf } from "bunite-core/rpc";
import type {
  AppStatusSnapshot,
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult,
  SequencedShellCoreEvent,
  ShellPaneRecordSnapshot,
  WorkspaceStatusSnapshot
} from "@flmux/core/shell/types";
import type { FlmuxRuntimeMode } from "./runtimeMode";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

export interface FlmuxShellSnapshot {
  app: AppStatusSnapshot;
  workspaces: WorkspaceStatusSnapshot[];
  panes: Record<string, ShellPaneRecordSnapshot[]>;
  paneParams: Record<string, Record<string, unknown> | undefined>;
  activeWorkspaceId: string | null;
}

export interface FlmuxSessionBootstrapResponse {
  /** Opaque resume token. Renderer stores in cookie/localStorage for the
   * next connection to call `resumeSession({resumeToken})` and recover the
   * same slot state (active workspace/pane). Equals the server-minted
   * sessionId; clients treat as opaque. */
  resumeToken: string;
  snapshot: FlmuxShellSnapshot;
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
  seqStart: number;
}

export interface FlmuxSessionSaveLayouts {
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
}

export interface FlmuxLocalExtensionLoadEntry {
  id: string;
  name: string;
  version: string;
  manifestUrl: string;
  rendererEntryUrl: string;
  paneIcons: Record<string, string>;
  paneDefaultTitles: Record<string, string>;
  paneMinimumWidths: Record<string, number>;
  paneMaximumWidths: Record<string, number>;
}

export interface FlmuxRendererBootstrapConfig {
  mode: FlmuxRuntimeMode;
  appOrigin: string;
  projectDir: string;
  localExtensions: FlmuxLocalExtensionLoadEntry[];
  devMode: boolean;
}

// SessionCap — identity (sessionId/userId) is server-side in the impl factory's
// closure, not on the wire. Per-call args carry only data (sourcePaneId,
// workspaceId hints).
export const sessionCap = defineCap("flmux.session", {
  bootstrap: call<void, FlmuxSessionBootstrapResponse>(),

  get: call<{ path: string; sourcePaneId?: string; workspaceId?: string }, PathGetResult>(),
  list: call<{ path: string; sourcePaneId?: string; workspaceId?: string }, PathListResult>(),
  set: call<{ path: string; value: unknown; sourcePaneId?: string; workspaceId?: string }, PathSetResult>(),
  call: call<{ path: string; args?: Record<string, unknown>; sourcePaneId?: string; workspaceId?: string }, PathCallResult>(),

  events: stream<{ sinceSeq?: number }, SequencedShellCoreEvent>(),
  terminalEvents: stream<{ paneId: string }, TerminalRuntimeEvent>(),

  pushLayout: call<FlmuxSessionSaveLayouts, { ok: true }>(),
  getConfig: call<void, FlmuxRendererBootstrapConfig>()
});

export type SessionCap = ClientOf<typeof sessionCap>;
export type SessionCapImpl = ImplOf<typeof sessionCap>;

// flmuxBridgeCap — anonymous entry. Auth happens at WS upgrade; bridge
// methods mint sessionCap bound to the upgrade-time user. Per method:
// - createSession:        web, fresh slot.
// - resumeSession:        web, replays grace-window slot via cookie token.
// - createDesktopSession: preload only (attestation.level === "app-internal").
export const flmuxBridgeCap = defineCap("flmux.bridge", {
  createSession: call<void, typeof sessionCap>({ returns: cap(sessionCap) }),
  resumeSession: call<{ resumeToken: string }, typeof sessionCap>({ returns: cap(sessionCap) }),
  createDesktopSession: call<void, typeof sessionCap>({ returns: cap(sessionCap) })
});

export type FlmuxBridgeCap = ClientOf<typeof flmuxBridgeCap>;
export type FlmuxBridgeCapImpl = ImplOf<typeof flmuxBridgeCap>;

// HTTP envelopes — separate surface from cap RPC. Cookie identity, not cap.
export interface ClientScopedPathGetInput {
  authorityClientId: string;
  path: string;
}

export interface ClientScopedPathListInput {
  authorityClientId: string;
  path: string;
}

export interface ClientScopedPathSetInput {
  authorityClientId: string;
  path: string;
  value: unknown;
}

export interface ClientScopedPathCallInput {
  authorityClientId: string;
  path: string;
  args?: Record<string, unknown>;
}
