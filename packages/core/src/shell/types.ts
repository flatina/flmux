import type {
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalWriteResult
} from "../terminal/types";

export type ShellPathNodeKind = "leaf" | "object" | "collection" | "action";

export type PathErrorCode =
  | "NOT_FOUND"
  | "NOT_WRITABLE"
  | "NOT_CALLABLE"
  | "INVALID_VALUE"
  | "INVALID_PATH"
  | "ALREADY_EXISTS"
  | "NOT_EMPTY"
  | "NO_CURRENT_PANE"
  | "NOT_SUPPORTED"
  | "INTERNAL_ERROR";

export interface ShellPathEntry {
  name: string;
  path: string;
  kind: ShellPathNodeKind;
  writable: boolean;
}

export interface PathCallerContext {
  // Per-call data — callers may supply these.
  sourcePaneId?: string;
  workspaceId?: string;
  // Server-injected identity slot key. sessionImpl closure sets this; external
  // HTTP/CLI leave it unset and hit INVALID_VALUE on implicit-current paths.
  slotKey?: string;
}

export type Awaitable<T> = T | Promise<T>;

export type PathGetResult =
  | { ok: true; found: boolean; value: unknown }
  | { ok: false; code: PathErrorCode; error: string };

export type PathListResult =
  | { ok: true; found: boolean; entries: ShellPathEntry[] }
  | { ok: false; code: PathErrorCode; error: string };

export type PathSetResult = { ok: true; value: unknown } | { ok: false; code: PathErrorCode; error: string };

export type PathCallResult = { ok: true; value: unknown } | { ok: false; code: PathErrorCode; error: string };

export type BuiltinPaneKind = "browser" | "terminal" | "explorer" | "textEditor";

export type PaneKind = BuiltinPaneKind | (string & {});

export type PanePlacement = "within" | "left" | "right" | "above" | "below";

export interface AppStatusSnapshot {
  title: string;
  origin: string;
  runtimeLabel: string;
  /** Host app version (`packages/app/package.json`). Surfaced so extensions
   * and CLI can branch on host capabilities. Mirrors `FLMUX_APP_VERSION`. */
  version: string;
  /** CEF remote debugging port (desktop mode only). External tools can query
   * `http://127.0.0.1:{cefCdpPort}/json/list` and match a browser pane's URL
   * (see `/status/panes/{id}/browser/url`) to drive it via CDP. */
  cefCdpPort?: number;
}

export interface WorkspaceStatusSnapshot {
  id: string;
  title: string;
  defaultTitle: string;
  paneCount: number;
}

// Phase B per-client active state. `slotKey` is an opaque id the core
// does not interpret; the authority (or test harness) chooses what it names
// — desktop maps one client to `"local"`. Core just routes.
export interface ActiveStateSlot {
  activeWorkspaceId: string | null;
  activePaneIdByWorkspace: Map<string, string>;
}

export interface BrowserPaneStateSnapshot {
  url: string;
}

export interface PaneStateSnapshot {
  kind: PaneKind;
  title: string;
  browser?: BrowserPaneStateSnapshot;
  terminal?: TerminalPaneStateSnapshot;
}

export interface PaneStatusSnapshot extends PaneStateSnapshot {
  id: string;
  browser?: BrowserPaneStateSnapshot;
  terminal?: TerminalPaneStatusSnapshot;
  /** Last time `setActive` (path call or host method) targeted this pane.
   * Absent when the pane has never been explicitly activated post-create. */
  lastActive?: PaneActiveRecord;
}

export type PaneActiveSource = "user" | "call";

export interface PaneActiveRecord {
  /** ISO-8601 UTC. */
  at: string;
  source: PaneActiveSource;
}

export interface ShellPaneRecordSnapshot extends PaneStatusSnapshot {}

export interface TerminalPaneStateSnapshot {
  cwd: string;
}

export interface TerminalPaneStatusSnapshot extends TerminalPaneStateSnapshot {
  attached: boolean;
  rootKey: string | null;
  runtimeId: string | null;
  alive: boolean | null;
  commandCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ShellResolvedPanePathMount {
  mountKey: string;
  getStateSnapshot(): Awaitable<Record<string, unknown> | undefined>;
  getStatusSnapshot(): Awaitable<Record<string, unknown> | undefined>;
  canSetStatePath?(relativePath: string[]): Awaitable<boolean>;
  setState?(relativePath: string[], value: unknown): Awaitable<{ value: unknown }>;
  canCallStatePath?(relativePath: string[]): Awaitable<boolean>;
  callState?(relativePath: string[], args: Record<string, unknown>): Awaitable<{ value: unknown }>;
}

export type ShellResolvedPaneSubtreeMount = ShellResolvedPanePathMount;

export interface NewPaneInput {
  kind: PaneKind;
  title?: string;
  url?: string;
  cwd?: string;
  params?: Record<string, unknown>;
  place?: PanePlacement;
  referencePaneId?: string;
}

export type ScopedPropertyTarget =
  | { scope: "app" }
  | { scope: "workspace"; workspaceId?: string }
  | { scope: "pane"; paneId: string };

export interface ShellSlotOptions {
  /** Opaque slot id (= clientId at authority level). Omit to use the core's default slot. */
  slotKey?: string;
}

export interface ShellSetActivePaneOptions extends ShellSlotOptions {
  /** Records the activation origin on the pane's status snapshot. Default `"call"`. */
  source?: PaneActiveSource;
}

export interface ShellCreatePaneOptions extends ShellSlotOptions {
  /** Explicit target workspace. When omitted the slot's current active workspace is used; if that too is null, the call fails with INVALID_VALUE. */
  workspaceId?: string;
}

/** Shape returned by `/status/clients/*`. Slot-level view state only —
 * transport-level metadata (connected, lastSeen) is a higher-layer concern. */
export interface ClientSlotSummary {
  clientId: string;
  /** Owning user. Desktop authority uses `"local"`; web authority fills in
   * the authenticated user name. Surfaced so extension server entries can
   * key session state per user via `/status/clients/{id}/userId`. */
  userId: string;
  activeWorkspaceId: string | null;
  activePaneIdByWorkspace: Record<string, string>;
}

export interface ShellModelHost {
  getAppStatus(): Awaitable<AppStatusSnapshot>;
  listWorkspaces(): Awaitable<WorkspaceStatusSnapshot[]>;
  createWorkspace(input?: { title?: string }, options?: ShellSlotOptions): Awaitable<WorkspaceStatusSnapshot>;
  resetWorkspace(workspaceId: string): Awaitable<WorkspaceStatusSnapshot>;
  deleteWorkspace(workspaceId: string): Awaitable<void>;
  setActiveWorkspace(workspaceId: string, options?: ShellSlotOptions): Awaitable<void>;
  getWorkspaceStatus(options?: ShellSlotOptions): Awaitable<WorkspaceStatusSnapshot>;
  getWorkspaceStatusById(workspaceId: string): Awaitable<WorkspaceStatusSnapshot>;
  listClientSlots(): Awaitable<ClientSlotSummary[]>;
  /** Slot-scoped "/panes/current" resolver. B1b interim; B1e retires the /current path entirely. */
  getCurrentPaneId(options?: ShellSlotOptions): Awaitable<string | null>;
  hasPaneKind(kind: string): Awaitable<boolean>;
  listPanes(options?: ShellSlotOptions): Awaitable<ShellPaneRecordSnapshot[]>;
  listPanesByWorkspace(workspaceId: string): Awaitable<ShellPaneRecordSnapshot[]>;
  getPane(paneId: string): Awaitable<ShellPaneRecordSnapshot | undefined>;
  createPane(input: NewPaneInput, options?: ShellCreatePaneOptions): Awaitable<ShellPaneRecordSnapshot>;
  /** Role gate — throws `ModelPathError` when the caller may not use `kind`. No-op when unguarded. */
  assertPaneKindAllowed(kind: string): void;
  closePane(paneId: string): Awaitable<{ paneId: string; closed: boolean }>;
  setActivePane(paneId: string, options?: ShellSetActivePaneOptions): Awaitable<void>;
  setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown): Awaitable<{ value: unknown }>;
  getPaneParams(paneId: string): Awaitable<Record<string, unknown> | undefined>;
  setPaneParams(paneId: string, nextParams: Record<string, unknown>): Awaitable<Record<string, unknown>>;
  patchPaneParams(paneId: string, patch: Record<string, unknown>): Awaitable<Record<string, unknown>>;
  getPaneSubtreeMounts(paneId: string): Awaitable<ShellResolvedPaneSubtreeMount[]>;
  getPanePathMount(paneId: string): Awaitable<ShellResolvedPanePathMount | undefined>;
  publishWorkspaceEvent(input: { topic: string; sourcePaneId: string; payload: unknown }): Awaitable<WorkspaceBusEvent>;
}

export interface ShellTerminalDelegate {
  /** Try adopt-by-paneId first; fall back to create if no surviving runtime exists. */
  attachRuntime(paneId: string, input: { cwd?: string }): Awaitable<TerminalCreateResult>;
  writeRuntime(paneId: string, input: { data: string }): Awaitable<TerminalWriteResult>;
  resizeRuntime(paneId: string, input: { cols: number; rows: number }): Awaitable<TerminalResizeResult>;
  readHistory(paneId: string, input: { maxBytes?: number }): Awaitable<TerminalHistoryResult>;
  killRuntime(paneId: string): Awaitable<TerminalKillResult>;
}

export interface ShellModelAPI {
  pathGet(path: string, caller?: PathCallerContext): Promise<PathGetResult>;
  pathList(path: string, caller?: PathCallerContext): Promise<PathListResult>;
  pathSet(path: string, value: unknown, caller?: PathCallerContext): Promise<PathSetResult>;
  pathCall(path: string, args?: Record<string, unknown>, caller?: PathCallerContext): Promise<PathCallResult>;
}

export interface WorkspaceBusEvent<T = unknown> {
  topic: string;
  workspaceId: string;
  sourcePaneId: string;
  payload: T;
  timestamp: number;
}

export interface WorkspaceBus {
  publish<T>(event: WorkspaceBusEvent<T>): void;
  subscribe<T>(topic: string, handler: (event: WorkspaceBusEvent<T>) => void): () => void;
}

export type ShellCoreEvent =
  | { topic: "app.titleChanged"; payload: { title: string } }
  | { topic: "workspace.added"; payload: { id: string; title: string; defaultTitle: string } }
  | { topic: "workspace.removed"; payload: { id: string } }
  | { topic: "workspace.titleChanged"; payload: { id: string; title: string } }
  | { topic: "workspace.activeChanged"; payload: { id: string | null } }
  | {
      topic: "pane.added";
      payload: {
        paneId: string;
        workspaceId: string;
        snapshot: ShellPaneRecordSnapshot;
        params: Record<string, unknown> | undefined;
        place?: PanePlacement;
        referencePaneId?: string;
      };
    }
  | { topic: "pane.removed"; payload: { paneId: string; workspaceId: string } }
  | { topic: "pane.titleChanged"; payload: { paneId: string; workspaceId: string; title: string } }
  | {
      topic: "pane.paramsChanged";
      payload: {
        paneId: string;
        workspaceId: string;
        params: Record<string, unknown> | undefined;
        snapshot: ShellPaneRecordSnapshot;
      };
    }
  | { topic: "pane.activeChanged"; payload: { workspaceId: string; paneId: string | null } };

export type ShellCoreEventTopic = ShellCoreEvent["topic"];

/**
 * Topic→scope policy. `"client"` events go to one slot only
 * (targetClientId on the envelope); `"all"` events broadcast to every
 * subscriber. New topics must add an entry here — the envelope builder reads
 * from this table so forgetting the entry fails compilation.
 */
export const SHELL_CORE_EVENT_SCOPES = {
  "app.titleChanged": "all",
  "workspace.added": "all",
  "workspace.removed": "all",
  "workspace.titleChanged": "all",
  "workspace.activeChanged": "client",
  "pane.added": "all",
  "pane.removed": "all",
  "pane.titleChanged": "all",
  "pane.paramsChanged": "all",
  "pane.activeChanged": "client"
} as const satisfies Record<ShellCoreEventTopic, "all" | "client">;

/**
 * Routing metadata on top of the semantic payload. `scope` is derived by the
 * core from the topic (see SHELL_CORE_EVENT_SCOPES); `targetClientId` is
 * supplied by whoever drove the mutation (authority/preload passes
 * caller.clientId through) when scope === "client". Forwarders
 * filter on these two fields alone — handlers never re-check.
 */
export type SequencedShellCoreEvent = ShellCoreEvent & {
  seq: number;
  scope: "all" | "client";
  targetClientId?: string;
};
