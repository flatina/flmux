import type {
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalWriteResult
} from "../terminal/terminal";

export type ShellPathNodeKind = "leaf" | "object" | "collection" | "action";

export type PathErrorCode =
  | "NOT_FOUND"
  | "NOT_WRITABLE"
  | "NOT_CALLABLE"
  | "INVALID_VALUE"
  | "INVALID_PATH"
  | "NO_CURRENT_PANE"
  | "INTERNAL_ERROR";

export interface ShellPathEntry {
  name: string;
  path: string;
  kind: ShellPathNodeKind;
  writable: boolean;
}

export interface PathCallerContext {
  sourcePaneId?: string;
  // Phase B: routing/context hints. `attachmentId` names the attachment
  // whose view-state a mutation targets (e.g. /workspaces/{id}/setActive);
  // `workspaceId` resolves implicit-current-workspace paths (/panes/new,
  // /status/workspace/*) for preload callers. Both optional here — wired
  // in later Phase B steps. External callers (CLI, raw HTTP) without an
  // attachment leave them unset and hit INVALID_VALUE on paths that need
  // the resolution.
  attachmentId?: string;
  workspaceId?: string;
}

export type Awaitable<T> = T | Promise<T>;

export type PathGetResult =
  | { ok: true; found: boolean; value: unknown }
  | { ok: false; code: PathErrorCode; error: string };

export type PathListResult =
  | { ok: true; found: boolean; entries: ShellPathEntry[] }
  | { ok: false; code: PathErrorCode; error: string };

export type PathSetResult =
  | { ok: true; value: unknown }
  | { ok: false; code: PathErrorCode; error: string };

export type PathCallResult =
  | { ok: true; value: unknown }
  | { ok: false; code: PathErrorCode; error: string };

export type BuiltinPaneKind = "browser" | "terminal";

export type PaneKind = BuiltinPaneKind | (string & {});

export type PanePlacement = "within" | "left" | "right" | "above" | "below";

export interface AppStatusSnapshot {
  title: string;
  origin: string;
  runtimeLabel: string;
}

export interface WorkspaceStatusSnapshot {
  id: string;
  title: string;
  defaultTitle: string;
  activePaneId: string | null;
  paneCount: number;
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

export interface BrowserPaneStatusSnapshot extends BrowserPaneStateSnapshot {}

export interface PaneStatusSnapshot extends PaneStateSnapshot {
  id: string;
  active: boolean;
  browser?: BrowserPaneStatusSnapshot;
  terminal?: TerminalPaneStatusSnapshot;
}

export interface ShellPaneSnapshot extends PaneStateSnapshot {}

export interface ShellPaneStatusSnapshot extends PaneStatusSnapshot {}

export interface ShellPaneRecordSnapshot extends ShellPaneStatusSnapshot {}

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

export interface TerminalPaneRuntimeSnapshot extends TerminalPaneStatusSnapshot {}

export interface ShellResolvedPanePathMount {
  mountKey: string;
  getStateSnapshot(): Awaitable<Record<string, unknown> | undefined>;
  getStatusSnapshot(): Awaitable<Record<string, unknown> | undefined>;
  canSetStatePath?(relativePath: string[]): Awaitable<boolean>;
  setState?(relativePath: string[], value: unknown): Awaitable<{ value: unknown }>;
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

export interface ShellModelHost {
  getAppStatus(): Awaitable<AppStatusSnapshot>;
  listWorkspaces(): Awaitable<WorkspaceStatusSnapshot[]>;
  createWorkspace(input?: { title?: string }): Awaitable<WorkspaceStatusSnapshot>;
  resetWorkspace(workspaceId: string): Awaitable<WorkspaceStatusSnapshot>;
  deleteWorkspace(workspaceId: string): Awaitable<void>;
  setActiveWorkspace(workspaceId: string): Awaitable<void>;
  getWorkspaceStatus(): Awaitable<WorkspaceStatusSnapshot>;
  hasPaneKind(kind: string): Awaitable<boolean>;
  listPanes(): Awaitable<ShellPaneRecordSnapshot[]>;
  getPane(paneId: string): Awaitable<ShellPaneRecordSnapshot | undefined>;
  createPane(input: NewPaneInput): Awaitable<ShellPaneRecordSnapshot>;
  closePane(paneId: string): Awaitable<{ paneId: string; closed: boolean }>;
  setActivePane(paneId: string): Awaitable<void>;
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
  pathGet(path: string): Promise<PathGetResult>;
  pathList(path: string): Promise<PathListResult>;
  pathSet(path: string, value: unknown): Promise<PathSetResult>;
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
  | { topic: "workspace.removed"; payload: { id: string; newActiveWorkspaceId: string | null } }
  | { topic: "workspace.titleChanged"; payload: { id: string; title: string } }
  | { topic: "workspace.activeChanged"; payload: { id: string | null } }
  | { topic: "pane.added"; payload: { paneId: string; workspaceId: string; snapshot: ShellPaneRecordSnapshot; params: Record<string, unknown> | undefined; place?: PanePlacement; referencePaneId?: string } }
  | { topic: "pane.removed"; payload: { paneId: string; workspaceId: string; newActivePaneId: string | null } }
  | { topic: "pane.titleChanged"; payload: { paneId: string; workspaceId: string; title: string } }
  | { topic: "pane.paramsChanged"; payload: { paneId: string; workspaceId: string; params: Record<string, unknown> | undefined; snapshot: ShellPaneRecordSnapshot } }
  | { topic: "pane.activeChanged"; payload: { workspaceId: string; paneId: string | null } };

export type SequencedShellCoreEvent = ShellCoreEvent & { seq: number };
