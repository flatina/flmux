import type { TerminalHostAPI } from "../terminalHost";
import type { TerminalCreateResult, TerminalRuntimeSummary } from "../../shared/terminal";
import { isTerminalPaneRecord, type PaneRecord, type TerminalPaneRecord } from "../shell/paneRegistry";

export interface TerminalWorkspaceRecord {
  id: string;
  paneRecords: Map<string, PaneRecord>;
}

export interface TerminalRuntimeState {
  cwd: string;
  rootKey: string | null;
  runtimeId: string | null;
  summary: TerminalRuntimeSummary | null;
}

export class TerminalCoordinator<W extends TerminalWorkspaceRecord> {
  constructor(private readonly deps: {
    installRoot: string;
    terminalHost: Pick<TerminalHostAPI, "adoptByPaneId" | "create" | "write" | "resize" | "history" | "kill">;
    resolveTerminalCwd(rootDir: string, inputCwd: string | undefined): string;
    findWorkspaceByPaneId(paneId: string): W | null;
    onRuntimeStateChange(workspace: W, paneId: string, state: TerminalRuntimeState): void;
  }) {}

  async attachRuntime(paneId: string, input: { cwd?: string }): Promise<TerminalCreateResult> {
    const { record } = this.requireTerminalPane(paneId);
    if (record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' already has an attached runtime`);
    }

    const adopt = await this.deps.terminalHost.adoptByPaneId({
      rootDir: this.deps.installRoot,
      paneId
    });
    if (adopt.outcome === "adopted") {
      return {
        ok: true,
        rootKey: adopt.rootKey,
        runtimeId: adopt.runtimeId,
        history: adopt.history,
        terminal: adopt.terminal
      };
    }

    return this.deps.terminalHost.create({
      paneId,
      rootDir: this.deps.installRoot,
      cwd: this.deps.resolveTerminalCwd(this.deps.installRoot, input.cwd ?? record.cwd)
    });
  }

  async writeRuntime(paneId: string, input: { data: string }) {
    const { record } = this.requireTerminalPane(paneId);
    if (!record.rootKey || !record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    return this.deps.terminalHost.write({
      rootKey: record.rootKey,
      runtimeId: record.runtimeId,
      data: input.data
    });
  }

  async readHistory(paneId: string, input: { maxBytes?: number }) {
    const { record } = this.requireTerminalPane(paneId);
    if (!record.rootKey || !record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    return this.deps.terminalHost.history({
      rootKey: record.rootKey,
      runtimeId: record.runtimeId,
      maxBytes: input.maxBytes
    });
  }

  async resizeRuntime(paneId: string, input: { cols: number; rows: number }) {
    const { record } = this.requireTerminalPane(paneId);
    if (!record.rootKey || !record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    return this.deps.terminalHost.resize({
      rootKey: record.rootKey,
      runtimeId: record.runtimeId,
      cols: input.cols,
      rows: input.rows
    });
  }

  async killRuntime(paneId: string) {
    const { workspace, record } = this.requireTerminalPane(paneId);
    if (!record.rootKey || !record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' is not attached to a runtime`);
    }

    const result = await this.deps.terminalHost.kill({
      rootKey: record.rootKey,
      runtimeId: record.runtimeId
    });
    this.deps.onRuntimeStateChange(workspace, paneId, {
      cwd: record.cwd,
      rootKey: null,
      runtimeId: null,
      summary: null
    });
    return result;
  }

  applyRuntimeStateChange(paneId: string, state: TerminalRuntimeState) {
    const workspace = this.deps.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      return;
    }

    this.deps.onRuntimeStateChange(workspace, paneId, state);
  }

  async killAttachedRuntime(workspace: W, paneId: string, record: PaneRecord) {
    if (!isTerminalPaneRecord(record) || !record.rootKey || !record.runtimeId) {
      return;
    }

    try {
      await this.deps.terminalHost.kill({
        rootKey: record.rootKey,
        runtimeId: record.runtimeId
      });
    } finally {
      this.deps.onRuntimeStateChange(workspace, paneId, {
        cwd: record.cwd,
        rootKey: null,
        runtimeId: null,
        summary: null
      });
    }
  }

  private requireTerminalPane(paneId: string) {
    const workspace = this.deps.findWorkspaceByPaneId(paneId);
    if (!workspace) {
      throw new Error(`Pane '${paneId}' does not belong to a known workspace`);
    }

    const record = workspace.paneRecords.get(paneId);
    if (!record) {
      throw new Error(`Pane '${paneId}' not found in workspace '${workspace.id}'`);
    }
    if (!isTerminalPaneRecord(record)) {
      throw new Error(`Pane '${paneId}' is not a terminal pane`);
    }

    return {
      workspace,
      record: record satisfies TerminalPaneRecord
    };
  }
}
