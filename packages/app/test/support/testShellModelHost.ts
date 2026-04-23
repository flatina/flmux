import type {
  NewPaneInput,
  ShellModelHost,
  ShellPaneRecordSnapshot,
  ShellResolvedPanePathMount,
  ShellResolvedPaneSubtreeMount,
  ScopedPropertyTarget,
  ShellTerminalDelegate,
  WorkspaceBusEvent,
  WorkspaceStatusSnapshot
} from "@flmux/core/shell/types";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import { createShellModel } from "@flmux/core/shell/model";
import type {
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalRuntimeEvent,
  TerminalWriteResult
} from "@flmux/core/terminal/types";
import { resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";
import { createSyntheticTerminalService } from "./syntheticTerminalService";

type StoredPane =
  | { id: string; kind: "browser"; title: string; url: string }
  | { id: string; kind: "cowsay"; title: string }
  | { id: string; kind: "inspector"; title: string; subscription?: string }
  | { id: string; kind: "scratchpad"; title: string; note?: string }
  | {
      id: string;
      kind: "terminal";
      title: string;
      cwd: string;
      rootKey: string | null;
      runtimeId: string | null;
      summary?: {
        alive?: boolean | null;
        commandCount?: number | null;
        createdAt?: string | null;
        updatedAt?: string | null;
      };
    };

interface TerminalServiceLike {
  create(input: { paneId?: string; rootDir: string; cwd?: string }): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
}

interface TestShellModelHostOptions {
  workspaceId?: string;
  workspaceTitle?: string;
  workspaceRootDir?: string;
  terminalRootKey?: string;
  appTitle?: string;
  appOrigin?: string;
  runtimeLabel?: string;
  activePaneId?: string | null;
  panes?: StoredPane[];
  terminalService?: TerminalServiceLike;
  onTerminalCreate?(paneId: string): void;
}

export class TestShellModelHost implements ShellModelHost {
  workspaceId: string;
  readonly calls = {
    createWorkspace: [] as Array<{ title?: string }>,
    createPane: [] as NewPaneInput[],
    setScopedProperty: [] as Array<{ target: ScopedPropertyTarget; key: string; value: unknown }>,
    setPaneParams: [] as Array<{ paneId: string; nextParams: Record<string, unknown> }>,
    patchPaneParams: [] as Array<{ paneId: string; patch: Record<string, unknown> }>,
    createTerminalRuntime: [] as Array<{ paneId: string; input: { cwd?: string } }>,
    writeTerminalRuntime: [] as Array<{ paneId: string; input: { data: string } }>,
    resizeTerminalRuntime: [] as Array<{ paneId: string; input: { cols: number; rows: number } }>,
    readTerminalHistory: [] as Array<{ paneId: string; input: { maxBytes?: number } }>,
    killTerminalRuntime: [] as string[],
    publishWorkspaceEvent: [] as Array<{ topic: string; sourcePaneId: string; payload: unknown }>
  };

  private appTitle: string;
  private appOrigin: string;
  private runtimeLabel: string;
  private workspaceTitle: string;
  private readonly workspaceRootDir: string;
  private readonly terminalService: TerminalServiceLike;
  private activePaneId: string | null;
  private readonly workspaceOrder: string[] = [];
  private readonly workspaceTitles = new Map<string, string>();
  private readonly workspacePaneCounts = new Map<string, number>();
  private readonly panes = new Map<string, StoredPane>();
  private readonly paneParams = new Map<string, Record<string, unknown> | undefined>();
  private readonly onTerminalCreate?: (paneId: string) => void;

  constructor(options: TestShellModelHostOptions = {}) {
    this.workspaceId = options.workspaceId ?? "workspace.test";
    this.appTitle = options.appTitle ?? "flmux";
    this.appOrigin = options.appOrigin ?? "http://127.0.0.1:4321";
    this.runtimeLabel = options.runtimeLabel ?? "test-host";
    this.workspaceTitle = options.workspaceTitle ?? "Workspace Test";
    this.workspaceRootDir = options.workspaceRootDir ?? "C:\\workspace";
    this.terminalService =
      options.terminalService ??
      createSyntheticTerminalService({
        rootKey: options.terminalRootKey
      });
    this.onTerminalCreate = options.onTerminalCreate;
    this.activePaneId = options.activePaneId ?? null;
    this.workspaceOrder.push(this.workspaceId);
    this.workspaceTitles.set(this.workspaceId, this.workspaceTitle);
    this.workspacePaneCounts.set(this.workspaceId, (options.panes ?? []).length);

    for (const pane of options.panes ?? []) {
      this.panes.set(pane.id, pane);
      this.paneParams.set(pane.id, this.createInitialPaneParams(pane));
    }
  }

  createModel(): ShellModelAPI {
    return createShellModel({
      host: this,
      terminal: this.createTerminalDelegate()
    });
  }

  createTerminalDelegate(): ShellTerminalDelegate {
    return {
      attachRuntime: async (paneId, input) => {
        const pane = this.requireTerminalPane(paneId);
        if (pane.runtimeId && pane.rootKey && pane.summary) {
          // Idempotent attach mirror of shellCore's real delegate: when
          // the pane already has a runtime, return its current snapshot
          // + history instead of re-entering create.
          const history = await this.readTerminalHistory(paneId, {});
          return {
            ok: true,
            rootKey: pane.rootKey,
            runtimeId: pane.runtimeId,
            history: history.data,
            terminal: {
              rootKey: pane.rootKey,
              rootDir: this.workspaceRootDir,
              runtimeId: pane.runtimeId,
              cwd: pane.cwd,
              alive: pane.summary.alive ?? true,
              commandCount: pane.summary.commandCount ?? 0,
              createdAt: pane.summary.createdAt ?? "",
              updatedAt: pane.summary.updatedAt ?? ""
            }
          };
        }
        return this.createTerminalRuntime(paneId, input);
      },
      writeRuntime: (paneId, input) => this.writeTerminalRuntime(paneId, input),
      resizeRuntime: (paneId, input) => this.resizeTerminalRuntime(paneId, input),
      readHistory: (paneId, input) => this.readTerminalHistory(paneId, input),
      killRuntime: (paneId) => this.killTerminalRuntime(paneId)
    };
  }

  setAppOrigin(origin: string) {
    this.appOrigin = origin;
  }

  applyTerminalEvent(event: TerminalRuntimeEvent) {
    const paneId = event.paneId ?? null;
    if (!paneId) {
      return;
    }

    const pane = this.panes.get(paneId);
    if (!pane || pane.kind !== "terminal") {
      return;
    }

    if (event.type === "state") {
      pane.cwd = event.terminal.cwd;
      pane.rootKey = event.terminal.rootKey;
      pane.runtimeId = event.terminal.runtimeId;
      pane.summary = {
        alive: event.terminal.alive,
        commandCount: event.terminal.commandCount,
        createdAt: event.terminal.createdAt,
        updatedAt: event.terminal.updatedAt
      };
      return;
    }

    if (event.type === "removed") {
      pane.rootKey = null;
      pane.runtimeId = null;
      pane.summary = undefined;
    }
  }

  getAppStatus() {
    return {
      title: this.appTitle,
      origin: this.appOrigin,
      runtimeLabel: this.runtimeLabel
    };
  }

  listWorkspaces() {
    this.syncCurrentWorkspaceSnapshot();
    return this.workspaceOrder.map((workspaceId) => ({
      id: workspaceId,
      title: this.workspaceTitles.get(workspaceId) ?? workspaceId,
      defaultTitle: this.workspaceTitles.get(workspaceId) ?? workspaceId,
      paneCount: this.workspacePaneCounts.get(workspaceId) ?? 0
    }));
  }

  createWorkspace(input: { title?: string } = {}) {
    this.syncCurrentWorkspaceSnapshot();
    this.calls.createWorkspace.push(input);

    let index = this.workspaceOrder.length + 1;
    while (this.workspaceTitles.has(`workspace.${index}`)) {
      index += 1;
    }

    this.workspaceId = `workspace.${index}`;
    this.workspaceTitle = input.title?.trim() || `Workspace ${index}`;
    this.activePaneId = null;
    this.panes.clear();
    this.paneParams.clear();
    this.workspaceOrder.push(this.workspaceId);
    this.workspaceTitles.set(this.workspaceId, this.workspaceTitle);
    this.seedDefaultWorkspaceLayout();
    return this.getWorkspaceStatus();
  }

  resetWorkspace(workspaceId: string): WorkspaceStatusSnapshot {
    if (workspaceId !== this.workspaceId) {
      throw new Error(`Test host can only reset the current workspace '${this.workspaceId}'`);
    }
    this.activePaneId = null;
    this.panes.clear();
    this.paneParams.clear();
    this.workspaceTitle = this.workspaceTitles.get(workspaceId) ?? `Workspace`;
    this.seedDefaultWorkspaceLayout();
    return this.getWorkspaceStatus();
  }

  deleteWorkspace(workspaceId: string): void {
    this.workspaceTitles.delete(workspaceId);
    this.workspacePaneCounts.delete(workspaceId);
    const index = this.workspaceOrder.indexOf(workspaceId);
    if (index >= 0) {
      this.workspaceOrder.splice(index, 1);
    }
    if (this.workspaceId === workspaceId) {
      this.panes.clear();
      this.paneParams.clear();
      this.activePaneId = null;
      this.workspaceId = this.workspaceOrder[0] ?? "";
      this.workspaceTitle = this.workspaceTitles.get(this.workspaceId) ?? "";
    }
  }

  setActiveWorkspace(workspaceId: string): void {
    if (this.workspaceOrder.includes(workspaceId)) {
      this.workspaceId = workspaceId;
      this.workspaceTitle = this.workspaceTitles.get(workspaceId) ?? this.workspaceTitle;
    }
  }

  setActivePane(paneId: string): void {
    if (this.panes.has(paneId)) {
      this.activePaneId = paneId;
    }
  }

  getWorkspaceStatus(): WorkspaceStatusSnapshot {
    this.syncCurrentWorkspaceSnapshot();
    return {
      id: this.workspaceId,
      title: this.workspaceTitle,
      defaultTitle: this.workspaceTitles.get(this.workspaceId) ?? this.workspaceTitle,
      paneCount: this.panes.size
    };
  }

  getWorkspaceStatusById(workspaceId: string): WorkspaceStatusSnapshot {
    if (!this.workspaceTitles.has(workspaceId)) {
      throw new Error(`Unknown workspace '${workspaceId}'`);
    }
    const title = this.workspaceTitles.get(workspaceId) ?? workspaceId;
    return {
      id: workspaceId,
      title,
      defaultTitle: title,
      paneCount: workspaceId === this.workspaceId ? this.panes.size : (this.workspacePaneCounts.get(workspaceId) ?? 0)
    };
  }

  listAttachmentSlots() {
    return [
      {
        attachmentId: "test",
        userId: "test-user",
        activeWorkspaceId: this.workspaceId,
        activePaneIdByWorkspace: this.activePaneId ? { [this.workspaceId]: this.activePaneId } : {}
      }
    ];
  }

  listPanesByWorkspace(workspaceId: string): ShellPaneRecordSnapshot[] {
    if (workspaceId !== this.workspaceId) {
      return [];
    }
    return this.listPanes();
  }

  async getCurrentPaneId(): Promise<string | null> {
    this.syncCurrentWorkspaceSnapshot();
    return this.activePaneId;
  }

  hasPaneKind(kind: string): boolean {
    return (
      kind === "browser" || kind === "cowsay" || kind === "terminal" || kind === "inspector" || kind === "scratchpad"
    );
  }

  setScopedProperty(target: ScopedPropertyTarget, key: string, value: unknown) {
    if (key !== "title") {
      throw new Error(`Unsupported scoped property '${key}'`);
    }

    const nextValue = asNonEmptyString(value, `${target.scope} property '${key}'`);
    this.calls.setScopedProperty.push({ target, key, value: nextValue });

    switch (target.scope) {
      case "app":
        this.appTitle = nextValue;
        return { value: this.appTitle };
      case "workspace": {
        const workspaceId = target.workspaceId ?? this.workspaceId;
        if (!this.workspaceTitles.has(workspaceId)) {
          throw new Error(`Unknown workspace '${workspaceId}'`);
        }

        if (workspaceId === this.workspaceId) {
          this.workspaceTitle = nextValue;
        }
        this.workspaceTitles.set(workspaceId, nextValue);
        return { value: nextValue };
      }
      case "pane": {
        const pane = this.requirePane(target.paneId);
        pane.title = nextValue;
        return { value: pane.title };
      }
    }
  }

  listPanes(): ShellPaneRecordSnapshot[] {
    return [...this.panes.keys()].map((paneId) => this.toPaneSnapshot(paneId));
  }

  getPane(paneId: string): ShellPaneRecordSnapshot | undefined {
    if (!this.panes.has(paneId)) {
      return undefined;
    }

    return this.toPaneSnapshot(paneId);
  }

  createPane(input: NewPaneInput): ShellPaneRecordSnapshot {
    this.calls.createPane.push(input);
    const paneId = `pane_${crypto.randomUUID()}`;
    const pane = this.createStoredPane(paneId, input);
    this.panes.set(paneId, pane);
    this.paneParams.set(paneId, this.createPaneParamsFromInput(pane, input));
    this.activePaneId = paneId;
    this.syncCurrentWorkspaceSnapshot();
    return this.toPaneSnapshot(paneId);
  }

  async closePane(paneId: string) {
    const pane = this.panes.get(paneId);
    if (pane?.kind === "terminal" && pane.rootKey && pane.runtimeId) {
      await this.terminalService.kill({
        rootKey: pane.rootKey,
        runtimeId: pane.runtimeId
      });
    }

    const closed = this.panes.delete(paneId);
    this.paneParams.delete(paneId);
    if (this.activePaneId === paneId) {
      this.activePaneId = [...this.panes.keys()].at(-1) ?? null;
    }
    this.syncCurrentWorkspaceSnapshot();

    return { paneId, closed };
  }

  getPaneParams(paneId: string) {
    return cloneJsonObject(this.paneParams.get(paneId));
  }

  setPaneParams(paneId: string, nextParams: Record<string, unknown>) {
    const pane = this.requirePane(paneId);
    const clonedParams = cloneJsonObject(nextParams) ?? {};
    this.paneParams.set(paneId, clonedParams);
    this.calls.setPaneParams.push({ paneId, nextParams: clonedParams });
    if (pane.kind === "scratchpad") {
      pane.note = typeof clonedParams.note === "string" ? clonedParams.note : "";
    }
    return clonedParams;
  }

  patchPaneParams(paneId: string, patch: Record<string, unknown>) {
    const nextPatch = cloneJsonObject(patch) ?? {};
    this.calls.patchPaneParams.push({ paneId, patch: nextPatch });
    return this.setPaneParams(paneId, {
      ...(this.getPaneParams(paneId) ?? {}),
      ...nextPatch
    });
  }

  getPaneSubtreeMounts(paneId: string): ShellResolvedPaneSubtreeMount[] {
    const pane = this.requirePane(paneId);
    if (pane.kind === "browser") {
      return [
        {
          mountKey: "browser",
          getStateSnapshot: () => ({
            url: pane.url
          }),
          canSetStatePath: (relativePath) => relativePath.length === 1 && relativePath[0] === "url",
          setState: (relativePath, value) => {
            if (relativePath.length !== 1 || relativePath[0] !== "url") {
              throw new Error(`Unsupported browser path '${relativePath.join("/")}'`);
            }

            const nextUrl = asNonEmptyString(value, "Pane url");
            pane.url = nextUrl;
            this.setPaneParams(paneId, { url: nextUrl });
            return { value: nextUrl };
          },
          getStatusSnapshot: () => ({
            url: pane.url
          })
        }
      ];
    }

    if (pane.kind === "terminal") {
      return [
        {
          mountKey: "terminal",
          getStateSnapshot: () => ({
            cwd: pane.cwd
          }),
          getStatusSnapshot: () => ({
            attached: pane.runtimeId !== null,
            rootKey: pane.rootKey,
            cwd: pane.cwd,
            runtimeId: pane.runtimeId,
            alive: pane.summary?.alive ?? null,
            commandCount: pane.summary?.commandCount ?? null,
            createdAt: pane.summary?.createdAt ?? null,
            updatedAt: pane.summary?.updatedAt ?? null
          })
        }
      ];
    }

    return [];
  }

  getPanePathMount(paneId: string): ShellResolvedPanePathMount | undefined {
    const pane = this.requirePane(paneId);
    if (pane.kind === "inspector") {
      return {
        mountKey: "inspector",
        getStateSnapshot: () => ({
          subscription: this.readInspectorSubscription(paneId)
        }),
        getStatusSnapshot: () => ({
          workspaceId: this.workspaceId,
          defaultBrowserPath: "/__flmux/internal/start?workspace=workspace.test"
        })
      };
    }

    if (pane.kind === "scratchpad") {
      return {
        mountKey: "scratchpad",
        getStateSnapshot: () => ({
          note: this.readScratchpadNote(paneId)
        }),
        canSetStatePath: (relativePath) => relativePath.length === 1 && relativePath[0] === "note",
        setState: (relativePath, value) => {
          if (relativePath.length !== 1 || relativePath[0] !== "note") {
            throw new Error(`Unsupported scratchpad path '${relativePath.join("/")}'`);
          }

          const note = typeof value === "string" ? value : "";
          this.setPaneParams(paneId, { note });
          return { value: note };
        },
        getStatusSnapshot: () => {
          const note = this.readScratchpadNote(paneId);
          return {
            noteLength: note.length
          };
        }
      };
    }

    return undefined;
  }

  async createTerminalRuntime(paneId: string, input: { cwd?: string }): Promise<TerminalCreateResult> {
    const pane = this.requireTerminalPane(paneId);
    this.calls.createTerminalRuntime.push({ paneId, input });
    this.onTerminalCreate?.(paneId);

    if (pane.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' already has an attached runtime`);
    }

    const result = await this.terminalService.create({
      paneId,
      rootDir: this.workspaceRootDir,
      cwd: resolveTerminalCwdFromRoot(this.workspaceRootDir, input.cwd ?? pane.cwd)
    });

    pane.runtimeId = result.runtimeId;
    pane.rootKey = result.rootKey;
    pane.cwd = result.terminal.cwd;
    pane.summary = {
      alive: result.terminal.alive,
      commandCount: result.terminal.commandCount,
      createdAt: result.terminal.createdAt,
      updatedAt: result.terminal.updatedAt
    };

    return result;
  }

  async writeTerminalRuntime(paneId: string, input: { data: string }): Promise<TerminalWriteResult> {
    const pane = this.requireTerminalPane(paneId);
    const runtimeId = pane.runtimeId;
    const rootKey = pane.rootKey;
    this.calls.writeTerminalRuntime.push({ paneId, input });

    if (!rootKey || !runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    const result = await this.terminalService.write({
      rootKey,
      runtimeId,
      data: input.data
    });

    if (result.terminal) {
      pane.summary = {
        alive: result.terminal.alive,
        commandCount: result.terminal.commandCount,
        createdAt: result.terminal.createdAt,
        updatedAt: result.terminal.updatedAt
      };
    }

    return result;
  }

  async readTerminalHistory(paneId: string, input: { maxBytes?: number }): Promise<TerminalHistoryResult> {
    const pane = this.requireTerminalPane(paneId);
    const runtimeId = pane.runtimeId;
    const rootKey = pane.rootKey;
    this.calls.readTerminalHistory.push({ paneId, input });

    if (!rootKey || !runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    return this.terminalService.history({
      rootKey,
      runtimeId,
      maxBytes: input.maxBytes
    });
  }

  async resizeTerminalRuntime(paneId: string, input: { cols: number; rows: number }): Promise<TerminalResizeResult> {
    const pane = this.requireTerminalPane(paneId);
    const runtimeId = pane.runtimeId;
    const rootKey = pane.rootKey;
    this.calls.resizeTerminalRuntime.push({ paneId, input });

    if (!rootKey || !runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    const result = await this.terminalService.resize({
      rootKey,
      runtimeId,
      cols: input.cols,
      rows: input.rows
    });

    if (result.terminal) {
      pane.summary = {
        alive: result.terminal.alive,
        commandCount: result.terminal.commandCount,
        createdAt: result.terminal.createdAt,
        updatedAt: result.terminal.updatedAt
      };
    }

    return result;
  }

  async killTerminalRuntime(paneId: string): Promise<TerminalKillResult> {
    const pane = this.requireTerminalPane(paneId);
    const runtimeId = pane.runtimeId;
    const rootKey = pane.rootKey;
    this.calls.killTerminalRuntime.push(paneId);

    if (!rootKey || !runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    const result = await this.terminalService.kill({
      rootKey,
      runtimeId
    });

    if (result.killed) {
      pane.rootKey = null;
      pane.runtimeId = null;
      pane.summary = undefined;
    }

    return result;
  }

  publishWorkspaceEvent(input: { topic: string; sourcePaneId: string; payload: unknown }): WorkspaceBusEvent {
    this.calls.publishWorkspaceEvent.push(input);
    return {
      topic: input.topic,
      sourcePaneId: input.sourcePaneId,
      payload: input.payload,
      workspaceId: this.workspaceId,
      timestamp: Date.now()
    };
  }

  private createStoredPane(paneId: string, input: NewPaneInput): StoredPane {
    switch (input.kind) {
      case "browser":
        return {
          id: paneId,
          kind: "browser",
          title: input.title?.trim() || "Start",
          url: input.url ?? `${this.appOrigin}${this.defaultBrowserPath()}`
        };

      case "cowsay":
        return {
          id: paneId,
          kind: "cowsay",
          title: input.title?.trim() || "Cowsay"
        };

      case "inspector":
        return {
          id: paneId,
          kind: "inspector",
          title: input.title?.trim() || "Inspector",
          subscription: typeof input.params?.subscription === "string" ? input.params.subscription : "*"
        };

      case "scratchpad":
        return {
          id: paneId,
          kind: "scratchpad",
          title: input.title?.trim() || "Scratchpad",
          note: typeof input.params?.note === "string" ? input.params.note : ""
        };

      case "terminal":
        return {
          id: paneId,
          kind: "terminal",
          title: input.title?.trim() || "Terminal",
          cwd: resolveTerminalCwdFromRoot(this.workspaceRootDir, input.cwd),
          rootKey: null,
          runtimeId: null
        };
    }

    throw new Error(`Unsupported pane kind '${String(input.kind)}'`);
  }

  private requirePane(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane) {
      throw new Error(`Pane '${paneId}' not found`);
    }

    return pane;
  }

  private requireTerminalPane(paneId: string) {
    const pane = this.requirePane(paneId);
    if (pane.kind !== "terminal") {
      throw new Error(`Pane '${paneId}' is not a terminal pane`);
    }

    return pane;
  }

  private createInitialPaneParams(pane: StoredPane) {
    if (pane.kind === "browser") {
      return { url: pane.url };
    }

    if (pane.kind === "terminal") {
      return {
        cwd: pane.cwd
      };
    }

    if (pane.kind === "scratchpad") {
      return {
        note: pane.note ?? ""
      };
    }

    if (pane.kind === "inspector") {
      return {
        subscription: pane.subscription ?? "*"
      };
    }

    return undefined;
  }

  private createPaneParamsFromInput(pane: StoredPane, input: NewPaneInput) {
    if (pane.kind === "browser") {
      return {
        url: pane.url
      };
    }

    if (pane.kind === "terminal") {
      return {
        cwd: pane.cwd
      };
    }

    if (pane.kind === "scratchpad") {
      return {
        note: typeof input.params?.note === "string" ? input.params.note : ""
      };
    }

    if (pane.kind === "inspector") {
      return {
        subscription: typeof input.params?.subscription === "string" ? input.params.subscription : "*"
      };
    }

    return cloneJsonObject(input.params);
  }

  private readScratchpadNote(paneId: string) {
    const params = this.getPaneParams(paneId);
    return typeof params?.note === "string" ? params.note : "";
  }

  private readInspectorSubscription(paneId: string) {
    const params = this.getPaneParams(paneId);
    return typeof params?.subscription === "string" && params.subscription.length > 0 ? params.subscription : "*";
  }

  private defaultBrowserPath() {
    return `/__flmux/internal/start?workspace=${this.workspaceId}`;
  }

  private syncCurrentWorkspaceSnapshot() {
    this.workspaceTitles.set(this.workspaceId, this.workspaceTitle);
    this.workspacePaneCounts.set(this.workspaceId, this.panes.size);
  }

  private seedDefaultWorkspaceLayout() {
    const cowsayId = `pane_${crypto.randomUUID()}`;
    const browserId = `pane_${crypto.randomUUID()}`;
    const cowsay = this.createStoredPane(cowsayId, {
      kind: "cowsay",
      title: "Cowsay"
    });
    const browser = this.createStoredPane(browserId, {
      kind: "browser",
      title: "Start",
      url: `${this.appOrigin}${this.defaultBrowserPath()}`
    });

    this.panes.set(cowsayId, cowsay);
    this.paneParams.set(cowsayId, this.createPaneParamsFromInput(cowsay, { kind: "cowsay", title: "Cowsay" }));
    this.panes.set(browserId, browser);
    if (browser.kind !== "browser") {
      throw new Error("expected seeded browser pane");
    }
    this.paneParams.set(
      browserId,
      this.createPaneParamsFromInput(browser, {
        kind: "browser",
        title: "Start",
        url: browser.url
      })
    );
    this.activePaneId = browserId;
    this.syncCurrentWorkspaceSnapshot();
  }

  private toPaneSnapshot(paneId: string): ShellPaneRecordSnapshot {
    const pane = this.requirePane(paneId);

    if (pane.kind === "browser") {
      return {
        id: pane.id,
        kind: pane.kind,
        title: pane.title,
        browser: {
          url: pane.url
        }
      };
    }

    if (pane.kind === "terminal") {
      return {
        id: pane.id,
        kind: pane.kind,
        title: pane.title,
        terminal: {
          attached: pane.runtimeId !== null,
          rootKey: pane.rootKey,
          cwd: pane.cwd,
          runtimeId: pane.runtimeId,
          alive: pane.summary?.alive ?? null,
          commandCount: pane.summary?.commandCount ?? null,
          createdAt: pane.summary?.createdAt ?? null,
          updatedAt: pane.summary?.updatedAt ?? null
        }
      };
    }

    return {
      id: pane.id,
      kind: pane.kind,
      title: pane.title
    };
  }
}

function cloneJsonObject(value: unknown) {
  return value && typeof value === "object"
    ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  return trimmed;
}
