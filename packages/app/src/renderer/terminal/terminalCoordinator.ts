import { pushTerminalEvent, type TerminalHostAPI } from "../terminalHost";
import type { TerminalRuntimeSummary } from "../../shared/terminal";
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
    terminalHost: Pick<TerminalHostAPI, "adoptByPaneId" | "create" | "write" | "resize" | "history" | "kill">;
    resolveTerminalCwd(rootDir: string, inputCwd: string | undefined): string;
    findWorkspaceByPaneId(paneId: string): W | null;
    onRuntimeStateChange(workspace: W, paneId: string, state: TerminalRuntimeState): void;
  }) {}

  async createRuntime(paneId: string, input: { cwd?: string }) {
    const { record } = this.requireTerminalPane(paneId);
    if (record.runtimeId) {
      throw new Error(`Terminal pane '${paneId}' already has an attached runtime`);
    }

    return this.deps.terminalHost.create({
      paneId,
      rootDir: record.rootDir,
      cwd: this.deps.resolveTerminalCwd(record.rootDir, input.cwd ?? record.cwd)
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

  async restoreTerminals(workspaces: Iterable<W>) {
    for (const workspace of workspaces) {
      for (const [paneId, record] of workspace.paneRecords.entries()) {
        if (!isTerminalPaneRecord(record) || record.runtimeId !== null) {
          continue;
        }

        try {
          const result = await this.deps.terminalHost.adoptByPaneId({
            rootDir: record.rootDir,
            paneId
          });
          if (result.outcome === "adopted") {
            this.attachRestoredRuntime(workspace, paneId, {
              cwd: result.terminal.cwd,
              rootKey: result.rootKey,
              runtimeId: result.runtimeId,
              summary: result.terminal,
              history: result.history
            });
            continue;
          }
        } catch (error) {
          console.warn(`failed to adopt restored terminal pane '${paneId}'`, error);
        }

        try {
          const created = await this.createRuntime(paneId, {
            cwd: record.cwd
          });
          this.attachRestoredRuntime(workspace, paneId, {
            cwd: created.terminal.cwd,
            rootKey: created.rootKey,
            runtimeId: created.runtimeId,
            summary: created.terminal,
            history: created.history
          });
        } catch (error) {
          console.warn(`failed to recreate restored terminal pane '${paneId}'`, error);
        }
      }
    }
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

  private attachRestoredRuntime(
    workspace: W,
    paneId: string,
    input: {
      cwd: string;
      rootKey: string;
      runtimeId: string;
      summary: TerminalRuntimeSummary;
      history: string;
    }
  ) {
    this.deps.onRuntimeStateChange(workspace, paneId, {
      cwd: input.cwd,
      rootKey: input.rootKey,
      runtimeId: input.runtimeId,
      summary: input.summary
    });
    pushTerminalEvent({
      type: "state",
      paneId,
      terminal: input.summary
    });
    if (input.history.length > 0) {
      pushTerminalEvent({
        type: "output",
        paneId,
        runtimeId: input.runtimeId,
        data: input.history
      });
    }
  }
}
