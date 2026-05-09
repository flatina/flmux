import type { TerminalBackend } from "../terminal/backend";
import type { TerminalRuntimeEvent } from "../terminal/types";
import { resolveTerminalCwdFromRoot } from "../terminal/path";
import {
  PLACEHOLDER_PANE_KIND,
  createPaneSnapshot as createPaneSnapshotHelper,
  createPaneStateRecord,
  isTerminalPaneStateRecord,
  resolvePaneCreateParams,
  resolvePaneTitle,
  serializePaneParams as serializePaneParamsHelper,
  type PanePathMount,
  type PanePathMountContext,
  type PaneSpec,
  type PaneSpecRegistry,
  type PaneStateRecord,
  type PaneWorkspaceContext
} from "./panes";
import { ModelPathError } from "./model";
import { createWorkspaceBus } from "./workspaceBus";
import {
  SHELL_CORE_EVENT_SCOPES,
  type ActiveStateSlot,
  type AppStatusSnapshot,
  type Awaitable,
  type NewPaneInput,
  type ScopedPropertyTarget,
  type SequencedShellCoreEvent,
  type ShellCoreEvent,
  type ShellCreatePaneOptions,
  type ShellModelHost,
  type ShellPaneRecordSnapshot,
  type ShellResolvedPanePathMount,
  type ShellResolvedPaneSubtreeMount,
  type ShellSetActivePaneOptions,
  type ShellSlotOptions,
  type ShellTerminalDelegate,
  type PaneActiveRecord,
  type WorkspaceBus,
  type WorkspaceBusEvent,
  type WorkspaceStatusSnapshot
} from "./types";

interface WorkspaceRecord {
  id: string;
  title: string;
  defaultTitle: string;
  defaultBrowserPath: string;
  bus: WorkspaceBus;
  paneOrder: string[];
  paneTitles: Map<string, string>;
  paneStates: Map<string, PaneStateRecord>;
  paneParams: Map<string, Record<string, unknown> | undefined>;
}

export interface ShellCoreOptions {
  paneRegistry: PaneSpecRegistry;
  runtimeLabel: string;
  /** Install root used to resolve terminal cwd and as the ptyd root. */
  projectDir: string;
  terminalBackend: TerminalBackend;
  initialAppOrigin?: string;
  /** CEF remote debugging port — desktop mode only. Surfaced through
   * `/status/app/cefCdpPort` so external tools can drive browser panes via
   * CDP without a private channel. */
  cefCdpPort?: number;
  /** Host app version. Defaults to `"0.0.0"` for tests; production callers
   * pass `FLMUX_APP_VERSION`. Surfaced through `/status/app/version`. */
  appVersion?: string;
  /** Initial app title. Seeds `appTitle` before any session restore; runtime
   * `setAppTitle` (persisted in session.json) overrides on subsequent boots.
   * Defaults to `"flmux"`. */
  initialAppTitle?: string;
  /**
   * Slot key used when a mutation/read doesn't pass an explicit slot — i.e.
   * the "owner" client for initialize(), restoreWorkspace, and the
   * requireCurrentWorkspace() preload-convenience read. Authority callers
   * pass their clientId here (desktop: `"local"`); tests may omit.
   *
   * **B1b transition**: core treats defaultSlotKey as the implicit target
   * for initialize/restore so the single-client world behaves like the
   * pre-split core. When B2 lands per-client routing, initialize/restore
   * need an explicit slotKey argument or the shell bootstrap needs to be
   * driven from the authority rather than the core — at that point
   * defaultSlotKey should either go away or become strictly test-scoped.
   */
  defaultSlotKey?: string;
  /** Owning user. Authority passes its own user id — desktop: `"local"`,
   * web: authenticated `user.name`. Surfaced through
   * `/status/clients/{id}/userId` so extensions can key session state
   * per user (flmux only routes; extensions own their schema). */
  authorityUserId?: string;
}

const IMPLICIT_DEFAULT_SLOT_KEY = "default";

// paneId = `p<5 base36 minutes-since-epoch><2 base36 counter>` = 8 chars.
const PANE_ID_EPOCH_MS = Date.UTC(2026, 0, 1);
const PANE_ID_COUNTER_MOD = 1296;

export class ShellCore implements ShellModelHost {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly paneWorkspaceIds = new Map<string, string>();
  private readonly paneLastActive = new Map<string, PaneActiveRecord>();
  private readonly eventSubscribers = new Set<(event: SequencedShellCoreEvent) => void>();
  // Per-slot active state. `slotKey` is opaque to core — authority treats it
  // as clientId; tests treat it as a harness id. Core only routes.
  private readonly activeSlots = new Map<string, ActiveStateSlot>();
  private readonly defaultSlotKey: string;
  private paneIdCounter = 0;
  private appTitle: string;
  private appOrigin: string;
  private seq = 0;

  constructor(private readonly options: ShellCoreOptions) {
    this.appOrigin = options.initialAppOrigin ?? "http://127.0.0.1:0";
    this.appTitle = options.initialAppTitle ?? "flmux";
    this.defaultSlotKey = options.defaultSlotKey ?? IMPLICIT_DEFAULT_SLOT_KEY;
  }

  /**
   * Subscribe to mutation events. Returns an unsubscribe fn. Events carry
   * a monotonic `seq`; consumers doing bootstrap + stream should filter by
   * `seq > seqStart` where seqStart came from the bootstrap snapshot.
   */
  subscribe(handler: (event: SequencedShellCoreEvent) => void): () => void {
    this.eventSubscribers.add(handler);
    return () => this.eventSubscribers.delete(handler);
  }

  get currentSeq(): number {
    return this.seq;
  }

  /**
   * Emit with a routing envelope. `target` matters only for client-scoped
   * topics (per SHELL_CORE_EVENT_SCOPES); for all-broadcast topics the
   * argument is silently dropped — "routing isn't payload" made mechanical.
   * Callers that accidentally pass target to a broadcast topic won't leak
   * that into the envelope. Authority/mutation callers supply `target` via
   * caller.clientId → options.slotKey → here.
   */
  private emit(event: ShellCoreEvent, target?: string) {
    this.seq += 1;
    const scope = SHELL_CORE_EVENT_SCOPES[event.topic];
    const sequenced = {
      ...event,
      seq: this.seq,
      scope,
      targetClientId: scope === "client" ? target : undefined
    } as SequencedShellCoreEvent;
    for (const handler of this.eventSubscribers) {
      handler(sequenced);
    }
  }

  private ensureSlot(slotKey: string): ActiveStateSlot {
    let slot = this.activeSlots.get(slotKey);
    if (!slot) {
      slot = { activeWorkspaceId: null, activePaneIdByWorkspace: new Map() };
      this.activeSlots.set(slotKey, slot);
    }
    return slot;
  }

  private resolveSlotKey(options?: ShellSlotOptions): string {
    return options?.slotKey ?? this.defaultSlotKey;
  }

  initialize() {
    // Idempotent by default slot: once the default slot has an active ws, no-op.
    // "Default slot" is the implicit owner — authority names it "local" on
    // construction, tests leave it as "default". Other (non-default) slots
    // bootstrap themselves via setActiveWorkspace.
    const slot = this.ensureSlot(this.defaultSlotKey);
    if (slot.activeWorkspaceId) {
      return;
    }

    let workspace = this.workspaces.get("workspace.1");
    const created = !workspace;
    if (!workspace) {
      workspace = this.createWorkspaceRecord("workspace.1", "Workspace 1");
    }
    if (created) {
      this.emit({
        topic: "workspace.added",
        payload: { id: workspace.id, title: workspace.title, defaultTitle: workspace.defaultTitle }
      });
    }
    slot.activeWorkspaceId = workspace.id;
    this.emit({ topic: "workspace.activeChanged", payload: { id: workspace.id } }, this.defaultSlotKey);
  }

  /**
   * Create an empty workspace with an explicit id, without seeding default
   * panes. Used by the desktop workbench during session restore, where
   * dockview already holds the serialized panels — ShellCore just needs
   * the logical records rebuilt with the restored ids.
   */
  restoreWorkspace(input: { id: string; title: string; defaultTitle?: string; setActive?: boolean }) {
    const existed = this.workspaces.has(input.id);
    const workspace = this.createWorkspaceRecord(input.id, input.title);
    if (input.defaultTitle) {
      workspace.defaultTitle = input.defaultTitle;
    }
    // restoreWorkspace targets the default slot — it is a bootstrap-time
    // helper for the owner client (desktop session restore).
    const slot = this.ensureSlot(this.defaultSlotKey);
    const previousActiveWsId = slot.activeWorkspaceId;
    if (input.setActive || !slot.activeWorkspaceId) {
      slot.activeWorkspaceId = workspace.id;
    }
    if (!existed) {
      this.emit({
        topic: "workspace.added",
        payload: { id: workspace.id, title: workspace.title, defaultTitle: workspace.defaultTitle }
      });
    }
    if (previousActiveWsId !== slot.activeWorkspaceId) {
      this.emit({ topic: "workspace.activeChanged", payload: { id: slot.activeWorkspaceId } }, this.defaultSlotKey);
    }
    return this.toWorkspaceStatus(workspace);
  }

  /**
   * Rebuild a pane state record with an explicit paneId (skipping the usual
   * UUID generation). Used during session restore to match ids already
   * materialized in the view layer. Unknown kinds and lifecycle/persistence
   * throws are caught and substituted with the "placeholder" kind so a single
   * bad pane cannot abort the whole workspace restore.
   */
  restorePane(
    workspaceId: string,
    input: { paneId: string; kind: string; params?: Record<string, unknown>; title?: string }
  ): ShellPaneRecordSnapshot {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      return this.restorePaneWithSpec(workspace, input);
    } catch (err) {
      return this.restorePaneAsPlaceholder(workspace, input, err);
    }
  }

  private restorePaneWithSpec(
    workspace: WorkspaceRecord,
    input: { paneId: string; kind: string; params?: Record<string, unknown>; title?: string }
  ): ShellPaneRecordSnapshot {
    const spec = this.options.paneRegistry.get(input.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${input.kind}'`);
    }
    const workspaceContext = this.toWorkspaceContext(workspace);
    const params =
      spec.persistence?.normalizeRestoredParams?.({
        workspace: workspaceContext,
        params: input.params
      }) ?? input.params;

    const record = createPaneStateRecord({
      spec,
      workspace: workspaceContext,
      params
    });
    const normalizedParams = cloneJsonObject(params) ?? {};
    if (isTerminalPaneStateRecord(record)) {
      normalizedParams.cwd = record.cwd;
    }

    const title = input.title?.trim() || humanizePaneKind(input.kind);
    this.commitRestoredPane(workspace, input.paneId, record, normalizedParams, params, title);
    return this.createPaneSnapshot(workspace, input.paneId, title);
  }

  private restorePaneAsPlaceholder(
    workspace: WorkspaceRecord,
    input: { paneId: string; kind: string; params?: Record<string, unknown>; title?: string },
    cause: unknown
  ): ShellPaneRecordSnapshot {
    const placeholderSpec = this.options.paneRegistry.get(PLACEHOLDER_PANE_KIND);
    if (!placeholderSpec) {
      throw new Error(`Cannot substitute placeholder — pane kind '${PLACEHOLDER_PANE_KIND}' is not registered`);
    }
    const params: Record<string, unknown> = {
      originalKind: input.kind,
      error: cause instanceof Error ? cause.message : String(cause)
    };
    const workspaceContext = this.toWorkspaceContext(workspace);
    const record = createPaneStateRecord({
      spec: placeholderSpec,
      workspace: workspaceContext,
      params
    });
    const title = `Missing: ${input.kind}`;
    this.commitRestoredPane(workspace, input.paneId, record, params, params, title);
    return this.createPaneSnapshot(workspace, input.paneId, title);
  }

  private commitRestoredPane(
    workspace: WorkspaceRecord,
    paneId: string,
    record: PaneStateRecord,
    normalizedParams: Record<string, unknown>,
    fallbackParams: Record<string, unknown> | undefined,
    title: string
  ) {
    // Restore attributes the pane to the default slot (the owner client).
    const slot = this.ensureSlot(this.defaultSlotKey);
    const previousActivePaneId = slot.activePaneIdByWorkspace.get(workspace.id);
    workspace.paneOrder.push(paneId);
    workspace.paneTitles.set(paneId, title);
    workspace.paneStates.set(paneId, record);
    workspace.paneParams.set(paneId, Object.keys(normalizedParams).length > 0 ? normalizedParams : fallbackParams);
    slot.activePaneIdByWorkspace.set(workspace.id, paneId);
    this.paneWorkspaceIds.set(paneId, workspace.id);
    const snapshot = this.createPaneSnapshot(workspace, paneId, title);
    this.emit({
      topic: "pane.added",
      payload: {
        paneId,
        workspaceId: workspace.id,
        snapshot,
        params: workspace.paneParams.get(paneId)
      }
    });
    if (previousActivePaneId !== paneId) {
      this.emit({ topic: "pane.activeChanged", payload: { workspaceId: workspace.id, paneId } }, this.defaultSlotKey);
    }
  }

  setActiveWorkspace(workspaceId: string | null, options?: ShellSlotOptions) {
    const slotKey = this.resolveSlotKey(options);
    const slot = this.ensureSlot(slotKey);
    const next = workspaceId && this.workspaces.has(workspaceId) ? workspaceId : null;
    if (next === slot.activeWorkspaceId) {
      return;
    }
    slot.activeWorkspaceId = next;
    this.emit({ topic: "workspace.activeChanged", payload: { id: next } }, slotKey);
  }

  setActivePane(paneId: string, options?: ShellSetActivePaneOptions) {
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    if (!workspaceId) {
      return;
    }
    // Always refresh `lastActive` — re-clicking the already-active tab is
    // still a fresh user signal that should sort newest.
    this.paneLastActive.set(paneId, { at: new Date().toISOString(), source: options?.source ?? "call" });
    const slotKey = this.resolveSlotKey(options);
    const slot = this.ensureSlot(slotKey);
    if (slot.activePaneIdByWorkspace.get(workspaceId) === paneId) {
      return;
    }
    slot.activePaneIdByWorkspace.set(workspaceId, paneId);
    this.emit({ topic: "pane.activeChanged", payload: { workspaceId, paneId } }, slotKey);
  }

  clearActivePane(workspaceId: string, options?: ShellSlotOptions) {
    const slotKey = this.resolveSlotKey(options);
    const slot = this.activeSlots.get(slotKey);
    if (!slot?.activePaneIdByWorkspace.has(workspaceId)) {
      return;
    }
    slot.activePaneIdByWorkspace.delete(workspaceId);
    this.emit({ topic: "pane.activeChanged", payload: { workspaceId, paneId: null } }, slotKey);
  }

  /** Read the slot's current active workspace (defaults to defaultSlotKey). */
  getSlotActiveWorkspaceId(slotKey?: string): string | null {
    const key = slotKey ?? this.defaultSlotKey;
    return this.activeSlots.get(key)?.activeWorkspaceId ?? null;
  }

  /** Read the slot's active pane within a specific workspace. */
  getSlotActivePaneId(workspaceId: string, slotKey?: string): string | null {
    const key = slotKey ?? this.defaultSlotKey;
    return this.activeSlots.get(key)?.activePaneIdByWorkspace.get(workspaceId) ?? null;
  }

  setAppTitle(title: string) {
    if (this.appTitle === title) {
      return;
    }
    this.appTitle = title;
    this.emit({ topic: "app.titleChanged", payload: { title } });
  }

  getAppTitle(): string {
    return this.appTitle;
  }

  /** Sync equivalent of getAppStatus for callers that need {title, origin, runtimeLabel} without crossing an await. */
  getAppSnapshot(): AppStatusSnapshot {
    return {
      title: this.appTitle,
      origin: this.appOrigin,
      runtimeLabel: this.options.runtimeLabel,
      version: this.options.appVersion ?? "0.0.0",
      cefCdpPort: this.options.cefCdpPort
    };
  }

  getWorkspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  /**
   * Drop a workspace. Uses `closePane` per pane so terminal runtimes are
   * killed through the single existing cleanup path; no last-workspace
   * invariant is enforced (the caller owns re-seeding).
   *
   * Invariant: deleting a workspace fans out `pane.removed` for every
   * pane it owned. Every paneId-keyed index downstream
   * (renderer `paneIdToKind`, `paneTabMenuRegistry`, client registry,
   * …) relies on this hook as its sole cleanup signal.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }
    await Promise.all([...workspace.paneOrder].map((paneId) => this.closePane(paneId)));
    this.workspaces.delete(workspaceId);
    const nextWorkspaceId = this.workspaces.keys().next().value ?? null;

    // Every slot pointing at the deleted ws gets bumped to the next remaining
    // (or null if empty). Each affected slot gets its own client-scoped
    // workspace.activeChanged so handlers can re-point without re-checking
    // their own slot id.
    const affectedSlots: Array<{ slotKey: string; newId: string | null }> = [];
    for (const [slotKey, slot] of this.activeSlots) {
      if (slot.activeWorkspaceId === workspaceId) {
        slot.activeWorkspaceId = nextWorkspaceId;
        affectedSlots.push({ slotKey, newId: nextWorkspaceId });
      }
      slot.activePaneIdByWorkspace.delete(workspaceId);
    }

    this.emit({
      topic: "workspace.removed",
      payload: { id: workspaceId }
    });
    for (const { slotKey, newId } of affectedSlots) {
      this.emit({ topic: "workspace.activeChanged", payload: { id: newId } }, slotKey);
    }
    // ≥1 workspace invariant: closing the last workspace immediately re-seeds
    // a default so callers (/status/workspace, /api/clients, external model
    // reads) never observe a no-current-workspace state. initialize() moves
    // the default slot onto the new ws.1; any other slot that was also on the
    // deleted ws sat at null after step 3 — bump those too and emit per-slot
    // activeChanged so every client that lost its workspace ends up on
    // the reseed, not stuck at null.
    if (this.workspaces.size === 0) {
      this.initialize();
      const reseedWsId = this.activeSlots.get(this.defaultSlotKey)?.activeWorkspaceId ?? null;
      if (reseedWsId) {
        for (const { slotKey } of affectedSlots) {
          if (slotKey === this.defaultSlotKey) {
            // initialize() already handled the default slot.
            continue;
          }
          const slot = this.ensureSlot(slotKey);
          if (slot.activeWorkspaceId === null) {
            slot.activeWorkspaceId = reseedWsId;
            this.emit({ topic: "workspace.activeChanged", payload: { id: reseedWsId } }, slotKey);
          }
        }
      }
    }
  }

  /**
   * Workspace-scoped pane enumeration. Unlike `listPanes()` which targets the
   * active workspace, this is safe to call on inactive workspaces (e.g. during
   * a reset of a non-current workspace, or after bulk restore).
   */
  listPanesByWorkspace(workspaceId: string): ShellPaneRecordSnapshot[] {
    const workspace = this.requireWorkspace(workspaceId);
    return workspace.paneOrder.map((paneId) => this.createPaneSnapshot(workspace, paneId));
  }

  /** Existing-pane URL re-normalization on origin change is an adapter concern; core only records the value. */
  setAppOrigin(origin: string) {
    this.appOrigin = origin;
  }

  applyTerminalEvent(event: TerminalRuntimeEvent) {
    const paneId = event.paneId ?? null;
    if (!paneId) {
      return;
    }

    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return;
    }

    const pane = workspace.paneStates.get(paneId);
    if (!pane || !isTerminalPaneStateRecord(pane)) {
      return;
    }

    if (event.type === "state") {
      pane.cwd = event.terminal.cwd;
      pane.rootKey = event.terminal.rootKey;
      pane.runtimeId = event.terminal.runtimeId;
      pane.summary = event.terminal;
      return;
    }

    if (event.type === "removed") {
      pane.rootKey = null;
      pane.runtimeId = null;
      pane.summary = null;
    }
  }

  createTerminalDelegate(): ShellTerminalDelegate {
    const projectDir = this.options.projectDir;
    const backend = this.options.terminalBackend;
    return {
      attachRuntime: async (paneId, input) => {
        const { workspace, pane } = this.requireTerminalPane(paneId);

        // Idempotent: if this pane already has a live runtime (e.g. after
        // browser reload re-mounts the terminal), return the current
        // state + fresh history instead of rejecting. A second subscriber
        // (multi-device handoff) takes this path too.
        if (pane.runtimeId && pane.rootKey && pane.summary) {
          const historyResult = await backend.history({
            rootKey: pane.rootKey,
            runtimeId: pane.runtimeId
          });
          return {
            ok: true,
            rootKey: pane.rootKey,
            runtimeId: pane.runtimeId,
            history: historyResult.data ?? "",
            terminal: pane.summary
          };
        }

        const adopt = await backend.adoptByPaneId({
          rootDir: projectDir,
          paneId
        });
        if (adopt.outcome === "adopted") {
          pane.cwd = adopt.terminal.cwd;
          pane.rootKey = adopt.rootKey;
          pane.runtimeId = adopt.runtimeId;
          pane.summary = adopt.terminal;
          workspace.paneParams.set(paneId, { cwd: pane.cwd });
          return {
            ok: true,
            rootKey: adopt.rootKey,
            runtimeId: adopt.runtimeId,
            history: adopt.history,
            terminal: adopt.terminal
          };
        }

        const result = await backend.create({
          paneId,
          rootDir: projectDir,
          cwd: resolveTerminalCwdFromRoot(projectDir, input.cwd ?? pane.cwd),
          appOrigin: this.appOrigin
        });
        pane.cwd = result.terminal.cwd;
        pane.rootKey = result.rootKey;
        pane.runtimeId = result.runtimeId;
        pane.summary = result.terminal;
        workspace.paneParams.set(paneId, { cwd: pane.cwd });
        return result;
      },
      writeRuntime: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.write({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          data: input.data
        });
        if (result.terminal) {
          pane.summary = result.terminal;
        }
        return result;
      },
      resizeRuntime: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.resize({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          cols: input.cols,
          rows: input.rows
        });
        if (result.terminal) {
          pane.summary = result.terminal;
        }
        return result;
      },
      readHistory: async (paneId, input) => {
        const { pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        return await backend.history({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId,
          maxBytes: input.maxBytes
        });
      },
      killRuntime: async (paneId) => {
        const { workspace, pane } = this.requireTerminalPane(paneId);
        if (!pane.rootKey || !pane.runtimeId) {
          throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
        }

        const result = await backend.kill({
          rootKey: pane.rootKey,
          runtimeId: pane.runtimeId
        });
        pane.rootKey = null;
        pane.runtimeId = null;
        pane.summary = null;
        workspace.paneParams.set(paneId, { cwd: pane.cwd });
        return result;
      }
    };
  }

  // ── ShellModelHost implementation ──

  async getAppStatus(): Promise<AppStatusSnapshot> {
    return {
      title: this.appTitle,
      origin: this.appOrigin,
      runtimeLabel: this.options.runtimeLabel,
      version: this.options.appVersion ?? "0.0.0",
      cefCdpPort: this.options.cefCdpPort
    };
  }

  async listWorkspaces(): Promise<WorkspaceStatusSnapshot[]> {
    return [...this.workspaces.values()].map((workspace) => this.toWorkspaceStatus(workspace));
  }

  async createWorkspace(input: { title?: string } = {}, options?: ShellSlotOptions): Promise<WorkspaceStatusSnapshot> {
    const slotKey = this.resolveSlotKey(options);
    const slot = this.ensureSlot(slotKey);
    const descriptor = this.allocateWorkspaceDescriptor(input.title);
    const previousActiveWsId = slot.activeWorkspaceId;
    const workspace = this.createWorkspaceRecord(descriptor.id, descriptor.title);
    slot.activeWorkspaceId = workspace.id;
    this.emit({
      topic: "workspace.added",
      payload: { id: workspace.id, title: workspace.title, defaultTitle: workspace.defaultTitle }
    });
    if (previousActiveWsId !== slot.activeWorkspaceId) {
      this.emit({ topic: "workspace.activeChanged", payload: { id: slot.activeWorkspaceId } }, slotKey);
    }
    return this.toWorkspaceStatus(workspace);
  }

  async resetWorkspace(workspaceId: string): Promise<WorkspaceStatusSnapshot> {
    const workspace = this.requireWorkspace(workspaceId);
    for (const paneId of [...workspace.paneOrder]) {
      await this.closePane(paneId);
    }
    if (workspace.title !== workspace.defaultTitle) {
      workspace.title = workspace.defaultTitle;
      this.emit({
        topic: "workspace.titleChanged",
        payload: { id: workspace.id, title: workspace.title }
      });
    }
    return this.toWorkspaceStatus(workspace);
  }

  async getWorkspaceStatus(options?: ShellSlotOptions): Promise<WorkspaceStatusSnapshot> {
    return this.toWorkspaceStatus(this.requireSlotActiveWorkspace(options));
  }

  async getWorkspaceStatusById(workspaceId: string): Promise<WorkspaceStatusSnapshot> {
    return this.toWorkspaceStatus(this.requireWorkspace(workspaceId));
  }

  async getCurrentPaneId(options?: ShellSlotOptions): Promise<string | null> {
    const workspace = this.requireSlotActiveWorkspace(options);
    return this.getSlotActivePaneId(workspace.id, options?.slotKey);
  }

  async hasPaneKind(kind: string): Promise<boolean> {
    return this.options.paneRegistry.get(kind) !== undefined;
  }

  async listPanes(options?: ShellSlotOptions): Promise<ShellPaneRecordSnapshot[]> {
    const workspace = this.requireSlotActiveWorkspace(options);
    return workspace.paneOrder.map((paneId) => this.createPaneSnapshot(workspace, paneId));
  }

  /**
   * Slot-state summary for `/status/clients/*`. The authority names slots
   * after clients, so this is effectively "per-client view state"
   * from the core's perspective. Transport-level metadata (connected,
   * lastSeen) lives outside core and is merged in at a higher layer when
   * needed.
   */
  async listClientSlots(): Promise<import("./types").ClientSlotSummary[]> {
    const userId = this.options.authorityUserId ?? "local";
    return Array.from(this.activeSlots.entries()).map(([clientId, slot]) => ({
      clientId,
      userId,
      activeWorkspaceId: slot.activeWorkspaceId,
      activePaneIdByWorkspace: Object.fromEntries(slot.activePaneIdByWorkspace)
    }));
  }

  async getPane(paneId: string): Promise<ShellPaneRecordSnapshot | undefined> {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace?.paneStates.has(paneId)) {
      return undefined;
    }
    return this.createPaneSnapshot(workspace, paneId);
  }

  async createPane(input: NewPaneInput, options?: ShellCreatePaneOptions): Promise<ShellPaneRecordSnapshot> {
    const slotKey = this.resolveSlotKey(options);
    const workspaceId = options?.workspaceId ?? this.activeSlots.get(slotKey)?.activeWorkspaceId;
    if (!workspaceId) {
      // Surface as INVALID_VALUE at the path-call boundary (preflight #2
      // §"Caller-driven 구현 규칙" step 3). Throwing a plain Error would
      // degrade to INTERNAL_ERROR through toPathMutationError.
      throw new ModelPathError(
        "INVALID_VALUE",
        `createPane requires a target workspaceId (none given and slot '${slotKey}' has no active workspace)`
      );
    }
    const workspace = this.requireWorkspace(workspaceId);
    return this.addPane(workspace, input, slotKey);
  }

  async closePane(paneId: string): Promise<{ paneId: string; closed: boolean }> {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return { paneId, closed: false };
    }

    const pane = workspace.paneStates.get(paneId);
    if (pane && isTerminalPaneStateRecord(pane) && pane.rootKey && pane.runtimeId) {
      await this.options.terminalBackend.kill({
        rootKey: pane.rootKey,
        runtimeId: pane.runtimeId
      });
    }

    const closed = workspace.paneStates.delete(paneId);
    workspace.paneParams.delete(paneId);
    workspace.paneTitles.delete(paneId);
    workspace.paneOrder = workspace.paneOrder.filter((candidate) => candidate !== paneId);
    this.paneWorkspaceIds.delete(paneId);
    this.paneLastActive.delete(paneId);

    // Per-slot active update: only slots that had this pane active in this
    // workspace need to move. Each gets its own client-scoped event.
    const fallbackPaneId = workspace.paneOrder.at(-1) ?? null;
    const affectedSlots: Array<{ slotKey: string; newPaneId: string | null }> = [];
    for (const [slotKey, slot] of this.activeSlots) {
      if (slot.activePaneIdByWorkspace.get(workspace.id) === paneId) {
        if (fallbackPaneId !== null) {
          slot.activePaneIdByWorkspace.set(workspace.id, fallbackPaneId);
        } else {
          slot.activePaneIdByWorkspace.delete(workspace.id);
        }
        affectedSlots.push({ slotKey, newPaneId: fallbackPaneId });
      }
    }

    if (closed) {
      this.emit({
        topic: "pane.removed",
        payload: { paneId, workspaceId: workspace.id }
      });
      for (const { slotKey, newPaneId } of affectedSlots) {
        this.emit(
          {
            topic: "pane.activeChanged",
            payload: { workspaceId: workspace.id, paneId: newPaneId }
          },
          slotKey
        );
      }
    }

    return { paneId, closed };
  }

  async setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown): Promise<{ value: unknown }> {
    if (key !== "title") {
      throw new Error(`Unsupported scoped property '${key}'`);
    }

    const nextValue = requiredString(value, `${target.scope} property '${key}'`);
    if (target.scope === "app") {
      this.setAppTitle(nextValue);
      return { value: nextValue };
    }

    if (target.scope === "workspace") {
      const workspace = target.workspaceId
        ? this.requireWorkspace(target.workspaceId)
        : this.requireSlotActiveWorkspace();
      if (workspace.title !== nextValue) {
        workspace.title = nextValue;
        this.emit({ topic: "workspace.titleChanged", payload: { id: workspace.id, title: nextValue } });
      }
      return { value: nextValue };
    }

    const workspace = this.findWorkspaceByPaneId(target.paneId);
    if (!workspace) {
      throw new Error(`Pane '${target.paneId}' not found`);
    }
    if (workspace.paneTitles.get(target.paneId) !== nextValue) {
      workspace.paneTitles.set(target.paneId, nextValue);
      this.emit({
        topic: "pane.titleChanged",
        payload: { paneId: target.paneId, workspaceId: workspace.id, title: nextValue }
      });
    }
    return { value: nextValue };
  }

  async getPaneParams(paneId: string): Promise<Record<string, unknown> | undefined> {
    return this.peekPaneParams(paneId);
  }

  /** Synchronous pane-params read for view layers that need params at dockview mount time. */
  peekPaneParams(paneId: string): Record<string, unknown> | undefined {
    const workspace = this.findWorkspaceByPaneId(paneId);
    return cloneJsonObject(workspace?.paneParams.get(paneId));
  }

  /**
   * Run a pane's `persistence.serializeParams` hook to produce a portable
   * save-time params shape (e.g. browser strips app-origin prefix so restored
   * URLs re-resolve against the current origin). Returns undefined if the pane
   * is unknown or the spec declares no hook.
   */
  serializePaneParams(paneId: string): Record<string, unknown> | undefined {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return undefined;
    }
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      return undefined;
    }
    const spec = this.options.paneRegistry.get(record.kind);
    if (!spec) {
      return undefined;
    }
    return serializePaneParamsHelper({
      spec,
      workspace: this.toWorkspaceContext(workspace),
      record,
      currentParams: cloneJsonObject(workspace.paneParams.get(paneId))
    });
  }

  async setPaneParams(paneId: string, nextParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { workspace, record } = this.lookupPane(paneId);
    const cloned = cloneJsonObject(nextParams) ?? {};

    let stored: Record<string, unknown>;
    if (isTerminalPaneStateRecord(record) && typeof cloned.cwd === "string") {
      record.cwd = resolveTerminalCwdFromRoot(this.options.projectDir, cloned.cwd);
      stored = { cwd: record.cwd };
    } else {
      stored = cloned;
    }
    workspace.paneParams.set(paneId, stored);
    const snapshot = this.createPaneSnapshot(workspace, paneId);
    this.emit({
      topic: "pane.paramsChanged",
      payload: { paneId, workspaceId: workspace.id, params: stored, snapshot }
    });
    return stored;
  }

  async patchPaneParams(paneId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.setPaneParams(paneId, {
      ...((await this.getPaneParams(paneId)) ?? {}),
      ...(cloneJsonObject(patch) ?? {})
    });
  }

  async getPaneSubtreeMounts(paneId: string): Promise<ShellResolvedPaneSubtreeMount[]> {
    const { workspace, record, spec } = this.lookupPane(paneId);
    return (spec.subtreeMounts ?? []).map((mount) => this.resolvePaneMount(workspace, paneId, record, mount));
  }

  async getPanePathMount(paneId: string): Promise<ShellResolvedPanePathMount | undefined> {
    const { workspace, record, spec } = this.lookupPane(paneId);
    return spec.pathMount ? this.resolvePaneMount(workspace, paneId, record, spec.pathMount) : undefined;
  }

  async publishWorkspaceEvent(input: {
    topic: string;
    sourcePaneId: string;
    payload: unknown;
  }): Promise<WorkspaceBusEvent> {
    const workspace = this.requireWorkspaceForPane(input.sourcePaneId);
    const event: WorkspaceBusEvent = {
      topic: input.topic,
      sourcePaneId: input.sourcePaneId,
      payload: input.payload,
      workspaceId: workspace.id,
      timestamp: Date.now()
    };
    workspace.bus.publish(event);
    return event;
  }

  // ── Internal helpers ──

  private resolvePaneMount(
    workspace: WorkspaceRecord,
    paneId: string,
    record: PaneStateRecord,
    mount: PanePathMount
  ): ShellResolvedPanePathMount {
    const createContext = (): PanePathMountContext => ({
      paneId,
      workspace: this.toWorkspaceContext(workspace),
      record,
      currentParams: workspace.paneParams.get(paneId),
      setParams: async (nextParams) => await this.setPaneParams(paneId, nextParams),
      patchParams: async (patch) => await this.patchPaneParams(paneId, patch)
    });

    return {
      mountKey: mount.mountKey,
      getStateSnapshot: () => mount.getStateSnapshot?.(createContext()),
      canSetStatePath: mount.canSetStatePath
        ? (relativePath) => mount.canSetStatePath!(createContext(), relativePath)
        : undefined,
      setState: mount.setState
        ? (relativePath, value) => mount.setState!(createContext(), relativePath, value)
        : undefined,
      canCallStatePath: mount.canCallStatePath
        ? (relativePath) => mount.canCallStatePath!(createContext(), relativePath)
        : undefined,
      callState: mount.callState
        ? (relativePath, args) => mount.callState!(createContext(), relativePath, args)
        : undefined,
      getStatusSnapshot: () => mount.getStatusSnapshot?.(createContext())
    };
  }

  /**
   * Resolve the slot's active workspace record. Throws `INVALID_VALUE` when
   * the slot has no active ws — transport should surface this to the caller
   * with a pointer at the new explicit paths (`/status/workspaces/{id}`,
   * `/status/clients/{aid}/currentWorkspace`).
   */
  private requireSlotActiveWorkspace(options?: ShellSlotOptions): WorkspaceRecord {
    const slotKey = this.resolveSlotKey(options);
    const slot = this.activeSlots.get(slotKey);
    if (!slot?.activeWorkspaceId) {
      throw new ModelPathError(
        "INVALID_VALUE",
        `slot '${slotKey}' has no active workspace — pass a workspaceId explicitly or use /status/workspaces/{id}`
      );
    }
    return this.requireWorkspace(slot.activeWorkspaceId);
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    return workspace;
  }

  private requireWorkspaceForPane(paneId: string) {
    const workspace = this.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    return workspace;
  }

  private findWorkspaceByPaneId(paneId: string) {
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    return workspaceId ? (this.workspaces.get(workspaceId) ?? null) : null;
  }

  private requireTerminalPane(paneId: string) {
    const { workspace, record } = this.lookupPane(paneId);
    if (!isTerminalPaneStateRecord(record)) {
      throw new Error(`Pane '${paneId}' is not a terminal pane`);
    }
    return { workspace, pane: record };
  }

  private lookupPane(paneId: string): {
    workspace: WorkspaceRecord;
    record: PaneStateRecord;
    spec: PaneSpec;
  } {
    const workspace = this.requireWorkspaceForPane(paneId);
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    const spec = this.options.paneRegistry.get(record.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${record.kind}'`);
    }
    return { workspace, record, spec };
  }

  private toWorkspaceStatus(workspace: WorkspaceRecord): WorkspaceStatusSnapshot {
    return {
      id: workspace.id,
      title: workspace.title,
      defaultTitle: workspace.defaultTitle,
      paneCount: workspace.paneOrder.length
    };
  }

  /** Synchronous workspace snapshot for view layers that need to read core state during dockview mount. */
  getWorkspaceSnapshot(workspaceId: string): WorkspaceStatusSnapshot | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? this.toWorkspaceStatus(workspace) : undefined;
  }

  getWorkspaceContext(workspaceId: string): PaneWorkspaceContext | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? this.toWorkspaceContext(workspace) : undefined;
  }

  getPaneWorkspaceId(paneId: string): string | undefined {
    return this.paneWorkspaceIds.get(paneId);
  }

  private toWorkspaceContext(workspace: WorkspaceRecord): PaneWorkspaceContext {
    return {
      id: workspace.id,
      defaultBrowserPath: workspace.defaultBrowserPath,
      bus: workspace.bus,
      appOrigin: this.appOrigin
    };
  }

  private createPaneSnapshot(workspace: WorkspaceRecord, paneId: string, titleOverride?: string) {
    const record = workspace.paneStates.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found`);
    }
    const spec = this.options.paneRegistry.get(record.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${record.kind}'`);
    }
    const snapshot = createPaneSnapshotHelper({
      spec,
      paneId,
      title: titleOverride ?? workspace.paneTitles.get(paneId) ?? humanizePaneKind(record.kind),
      record
    });
    const lastActive = this.paneLastActive.get(paneId);
    return lastActive ? { ...snapshot, lastActive } : snapshot;
  }


  private createWorkspaceRecord(id: string, title: string) {
    const existing = this.workspaces.get(id);
    if (existing) {
      return existing;
    }

    const workspace: WorkspaceRecord = {
      id,
      title,
      defaultTitle: title,
      defaultBrowserPath: `/__flmux/internal/start?workspace=${encodeURIComponent(id)}`,
      bus: createWorkspaceBus(id),
      paneOrder: [],
      paneTitles: new Map(),
      paneStates: new Map(),
      paneParams: new Map()
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  private allocatePaneId(): string {
    const minutes = Math.max(0, Math.floor((Date.now() - PANE_ID_EPOCH_MS) / 60_000));
    const t = minutes.toString(36).padStart(5, "0").slice(-5);
    const n = (this.paneIdCounter++ % PANE_ID_COUNTER_MOD).toString(36).padStart(2, "0");
    return `p${t}${n}`;
  }

  private allocateWorkspaceDescriptor(inputTitle?: string) {
    let index = this.workspaces.size + 1;
    while (this.workspaces.has(`workspace.${index}`)) {
      index += 1;
    }

    return {
      id: `workspace.${index}`,
      title: inputTitle?.trim() || `Workspace ${index}`
    };
  }

  private findPaneOfKind(workspace: WorkspaceRecord, kind: string): string | undefined {
    for (const paneId of workspace.paneOrder) {
      if (workspace.paneStates.get(paneId)?.kind === kind) return paneId;
    }
    return undefined;
  }

  private findAppSingleton(kind: string): { workspace: WorkspaceRecord; paneId: string } | undefined {
    for (const workspace of this.workspaces.values()) {
      const paneId = this.findPaneOfKind(workspace, kind);
      if (paneId) return { workspace, paneId };
    }
    return undefined;
  }

  private activateExistingSingleton(
    workspace: WorkspaceRecord,
    paneId: string,
    slotKey: string
  ): ShellPaneRecordSnapshot {
    const slot = this.ensureSlot(slotKey);
    if (slot.activePaneIdByWorkspace.get(workspace.id) !== paneId) {
      slot.activePaneIdByWorkspace.set(workspace.id, paneId);
      this.emit({ topic: "pane.activeChanged", payload: { workspaceId: workspace.id, paneId } }, slotKey);
    }
    return this.createPaneSnapshot(workspace, paneId);
  }

  private addPane(workspace: WorkspaceRecord, input: NewPaneInput, slotKey: string): ShellPaneRecordSnapshot {
    const spec = this.options.paneRegistry.get(input.kind);
    if (!spec) {
      throw new Error(`Unknown pane kind '${input.kind}'`);
    }
    if (spec.singletonScope === "workspace") {
      const existing = this.findPaneOfKind(workspace, input.kind);
      if (existing) {
        return this.activateExistingSingleton(workspace, existing, slotKey);
      }
    } else if (spec.singletonScope === "app") {
      const hit = this.findAppSingleton(input.kind);
      if (hit) {
        // Only activate when it lives in caller's active workspace —
        // never silently switch the active workspace itself.
        return hit.workspace === workspace
          ? this.activateExistingSingleton(workspace, hit.paneId, slotKey)
          : this.createPaneSnapshot(hit.workspace, hit.paneId);
      }
    }
    const paneId = this.allocatePaneId();
    const workspaceContext = this.toWorkspaceContext(workspace);
    const params = resolvePaneCreateParams({
      spec,
      workspace: workspaceContext,
      input,
      fallbackParams: cloneJsonObject(input.params)
    });
    const title = resolvePaneTitle({
      spec,
      workspace: workspaceContext,
      input,
      params,
      fallbackTitle: input.title?.trim() || humanizePaneKind(input.kind)
    });
    const record = createPaneStateRecord({
      spec,
      workspace: workspaceContext,
      params
    });
    const normalizedParams = cloneJsonObject(params) ?? {};
    if (isTerminalPaneStateRecord(record)) {
      normalizedParams.cwd = record.cwd;
    }

    const storedParams = Object.keys(normalizedParams).length > 0 ? normalizedParams : params;
    const slot = this.ensureSlot(slotKey);
    const previousActivePaneId = slot.activePaneIdByWorkspace.get(workspace.id);
    workspace.paneOrder.push(paneId);
    workspace.paneTitles.set(paneId, title);
    workspace.paneStates.set(paneId, record);
    workspace.paneParams.set(paneId, storedParams);
    slot.activePaneIdByWorkspace.set(workspace.id, paneId);
    this.paneWorkspaceIds.set(paneId, workspace.id);
    const snapshot = this.createPaneSnapshot(workspace, paneId, title);
    this.emit({
      topic: "pane.added",
      payload: {
        paneId,
        workspaceId: workspace.id,
        snapshot,
        params: storedParams,
        place: input.place,
        referencePaneId: input.referencePaneId
      }
    });
    if (previousActivePaneId !== paneId) {
      this.emit({ topic: "pane.activeChanged", payload: { workspaceId: workspace.id, paneId } }, slotKey);
    }
    return snapshot;
  }
}

// ── Exported helpers ──

export function normalizeBrowserUrl(
  previousOrigin: string,
  nextOrigin: string,
  value: string,
  defaultBrowserPath: string
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return `${nextOrigin}${defaultBrowserPath}`;
  }

  if (previousOrigin && trimmed.startsWith(previousOrigin)) {
    return `${nextOrigin}${trimmed.slice(previousOrigin.length)}`;
  }

  if (trimmed.startsWith("/")) {
    return `${nextOrigin}${trimmed}`;
  }

  if (trimmed.includes("://")) {
    return trimmed;
  }

  return `${nextOrigin}${defaultBrowserPath}`;
}

function humanizePaneKind(kind: string): string {
  return (
    kind
      .split(/[./_-]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Pane"
  );
}

function cloneJsonObject(value: unknown) {
  return value && typeof value === "object"
    ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  return trimmed;
}
