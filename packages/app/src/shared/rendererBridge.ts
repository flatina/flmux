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
import type { WorkspaceTabstripMode } from "./workspaceTabstrip";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

export interface FlmuxShellSnapshot {
  app: AppStatusSnapshot;
  workspaces: WorkspaceStatusSnapshot[];
  panes: Record<string, ShellPaneRecordSnapshot[]>;
  paneParams: Record<string, Record<string, unknown> | undefined>;
  activeWorkspaceId: string | null;
}

export interface FlmuxSessionBootstrapResponse {
  /** Opaque resume token; next connection passes via resumeSession to keep slot state. */
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
  paneMinimumSizes: Record<string, number>;
  paneMaximumSizes: Record<string, number>;
  paneInitialSizes: Record<string, number>;
  paneEdgeGroups: Record<string, "left" | "right" | "top" | "bottom">;
}

export interface FlmuxRendererBootstrapConfig {
  mode: FlmuxRuntimeMode;
  appName: string;
  appOrigin: string;
  projectDir: string;
  localExtensions: FlmuxLocalExtensionLoadEntry[];
  devMode: boolean;
  workspaceTabstrip: WorkspaceTabstripMode;
  /** Signed-in user (web mode only). Carries the login id + optional display
   * name so the renderer can render the Account settings section. Omitted in
   * desktop mode (single trusted local user, no account surface). */
  account?: { name: string; displayName?: string };
}

// Identity sealed in impl-factory closure; per-call args carry only data hints.
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

// Anonymous entry; auth at WS upgrade. createDesktopSession is preload-only (attestation gate).
export const flmuxBridgeCap = defineCap("flmux.bridge", {
  createSession: call<void, typeof sessionCap>({ returns: cap(sessionCap) }),
  resumeSession: call<{ resumeToken: string }, typeof sessionCap>({ returns: cap(sessionCap) }),
  createDesktopSession: call<void, typeof sessionCap>({ returns: cap(sessionCap) })
});

export type FlmuxBridgeCap = ClientOf<typeof flmuxBridgeCap>;
export type FlmuxBridgeCapImpl = ImplOf<typeof flmuxBridgeCap>;

// Renderer-served. Types below mirror bunite-core/rpc/framework structurally.
export type BrowserPaneModifier = "alt" | "ctrl" | "meta" | "shift";

export type BrowserPaneEvaluateResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

export type BrowserPaneScreenshotResult =
  | { ok: true; data: Uint8Array; mime: string; format: "png" | "jpeg" }
  | { ok: false; code: string; message: string };

export interface BrowserPaneCapabilities {
  evaluate: boolean;
  crossOriginEval: boolean;
  surfaceEvents: boolean;
  nativeInputTrusted: boolean;
  click: boolean;
  type: boolean;
  press: boolean;
  scroll: boolean;
  screenshot: boolean;
  accessibilitySnapshot?: boolean;
  getBoundingRect?: boolean;
  frames?: boolean;
  downloads?: boolean;
  popups?: boolean;
  resolveAndClick?: boolean;
  formats?: ("png" | "jpeg")[];
}

export type BrowserPaneResolveAndClickResult =
  | { ok: true; rect: { x: number; y: number; width: number; height: number }; isTrustedEvent: boolean }
  | { ok: false; code: string; message: string };

export interface BrowserPaneAxNode {
  nodeId: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  level?: number;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  invalid?: boolean;
  required?: boolean;
  selected?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  children?: BrowserPaneAxNode[];
}

export type BrowserPaneAccessibilitySnapshotResult =
  | { ok: true; tree: BrowserPaneAxNode }
  | { ok: false; code: string; message: string };

export type BrowserPaneBoundingRectResult =
  | { ok: true; rect: { x: number; y: number; width: number; height: number }; visible: boolean }
  | { ok: false; code: string; message: string };

export interface BrowserPaneFrame {
  frameId: string;
  parentFrameId: string | null;
  origin: string;
  url: string;
  name?: string;
}

export type BrowserPaneListFramesResult =
  | { ok: true; frames: BrowserPaneFrame[] }
  | { ok: false; code: string; message: string };

export type BrowserPaneNavigationState = {
  lastLoadEpoch: number;
  isLoading: boolean;
  currentUrl: string;
};

export type BrowserPaneDownloadPolicy = "auto" | "ask" | "block";

export type BrowserPaneDownloadEvent =
  | { kind: "started"; id: string; url: string; suggestedFilename: string; mimeType?: string; sizeBytes?: number }
  | { kind: "progress"; id: string; receivedBytes: number; totalBytes?: number }
  | { kind: "completed"; id: string; localPath: string }
  | { kind: "failed"; id: string; reason: string }
  | { kind: "blocked"; id: string; url: string; reason: string };

export type BrowserPaneWaitForDownloadResult =
  | {
      ok: true;
      id: string;
      suggestedFilename: string;
      url: string;
      mimeType?: string;
      sizeBytes?: number;
      localPath: string;
    }
  | { ok: false; code: string; message: string };

export type BrowserPaneDialogEvent =
  | {
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      requestId: number;
      message: string;
      defaultPrompt?: string;
    }
  | { kind: "auto-dismissed"; originalKind: string; message: string };

export type BrowserPaneWaitResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type BrowserPaneConsoleLevel = "log" | "warn" | "error" | "info" | "debug";
export interface BrowserPaneConsoleEntry {
  level: BrowserPaneConsoleLevel;
  args: string[];
  ts: number;
}

// prefer `SurfaceEvent` from bunite-core/rpc; this kept for cap schema.
export type BrowserPaneSurfaceEvent =
  | { type: "navigate"; epoch: number; url: string }
  | { type: "load-start"; epoch: number; url: string }
  | { type: "load-finish"; epoch: number; url: string }
  | { type: "load-fail"; epoch: number; url: string; reason?: string }
  | { type: "title-change"; epoch: number; title: string }
  | {
      type: "popup";
      epoch: number;
      url: string;
      disposition: "tab" | "window" | "popup";
      openerSurfaceId: number;
      newSurfaceId: number;
    };

export const paneBrowserCap = defineCap("flmux.paneBrowser", {
  evaluate: call<{ paneId: string; script: string; frameId?: string }, BrowserPaneEvaluateResult>(),
  click: call<{
    paneId: string;
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    clickCount?: number;
    modifiers?: BrowserPaneModifier[];
  }, void>(),
  type: call<{ paneId: string; text: string }, void>(),
  press: call<{ paneId: string; key: string; modifiers?: BrowserPaneModifier[] }, void>(),
  scroll: call<{
    paneId: string;
    dx: number;
    dy: number;
    x?: number;
    y?: number;
    modifiers?: BrowserPaneModifier[];
  }, void>(),
  screenshot: call<{ paneId: string; format?: "png" | "jpeg"; quality?: number }, BrowserPaneScreenshotResult>(),
  capabilities: call<{ paneId: string }, BrowserPaneCapabilities>(),
  goBack: call<{ paneId: string }, void>(),
  reload: call<{ paneId: string }, void>(),

  mouse: call<{
    paneId: string;
    action: "move" | "down" | "up";
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    modifiers?: BrowserPaneModifier[];
  }, void>(),
  dialogs: stream<{ paneId: string }, BrowserPaneDialogEvent>(),
  respondToDialog: call<{ paneId: string; requestId: number; accept: boolean; promptText?: string }, void>(),
  setDialogTimeout: call<{ paneId: string; ms: number | null }, void>(),
  waitForSelector: call<{
    paneId: string;
    selector: string;
    frameId?: string;
    timeoutMs?: number;
  }, BrowserPaneWaitResult>(),
  waitForFunction: call<{
    paneId: string;
    expression: string;
    frameId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }, BrowserPaneWaitResult>(),
  consoleEvents: stream<{ paneId: string }, BrowserPaneConsoleEntry>(),
  getConsoleBuffer: call<{ paneId: string; clear?: boolean }, BrowserPaneConsoleEntry[]>(),
  pressAction: call<{
    paneId: string;
    key: string;
    action: "down" | "up" | "both";
    modifiers?: BrowserPaneModifier[];
  }, void>(),

  getNavigationState: call<{ paneId: string }, BrowserPaneNavigationState>(),
  surfaceEvents: stream<{ paneId: string }, BrowserPaneSurfaceEvent>(),
  accessibilitySnapshot: call<{
    paneId: string;
    frameId?: string;
    interestingOnly?: boolean;
  }, BrowserPaneAccessibilitySnapshotResult>(),
  getBoundingRect: call<{
    paneId: string;
    selector: string;
    frameId?: string;
  }, BrowserPaneBoundingRectResult>(),
  listFrames: call<{ paneId: string }, BrowserPaneListFramesResult>(),
  setDownloadPolicy: call<{
    paneId: string;
    policy: BrowserPaneDownloadPolicy;
    downloadDir?: string;
  }, void>(),
  waitForDownload: call<{ paneId: string; timeoutMs?: number }, BrowserPaneWaitForDownloadResult>(),
  downloadEvents: stream<{ paneId: string }, BrowserPaneDownloadEvent>(),
  acceptPopup: call<{
    paneId: string;
    newSurfaceId: number;
    bounds: { x: number; y: number; width: number; height: number };
  }, { ok: true } | { ok: false; code: string; message: string }>(),
  dismissPopup: call<{ paneId: string; newSurfaceId: number }, void>(),
  extendPopupTimeout: call<
    { paneId: string; newSurfaceId: number; gracePeriodMs: number },
    | { ok: true; deadlineMs: number }
    | { ok: false; code: string; message: string }
  >(),
  resolveAndClick: call<
    {
      paneId: string;
      selector: string;
      frameId?: string;
      button?: "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: BrowserPaneModifier[];
    },
    BrowserPaneResolveAndClickResult
  >()
});

export type PaneBrowserCap = ClientOf<typeof paneBrowserCap>;
export type PaneBrowserCapImpl = ImplOf<typeof paneBrowserCap>;

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
