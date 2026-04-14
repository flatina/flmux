import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview-core";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "../shell/types";
import type {
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalRootStatus,
  TerminalRuntimeEvent,
  TerminalRuntimeSummary,
  TerminalWriteResult
} from "../../shared/terminal";

export interface TerminalPaneRendererDependencies {
  shellModel: ShellModelAPI;
  terminalEvents: Pick<TerminalHostAPI, "onEvent" | "listRoots">;
  onRuntimeStateChange(
    paneId: string,
    state: { cwd: string; rootKey: string | null; runtimeId: string | null; summary: TerminalRuntimeSummary | null }
  ): void;
}

type TerminalPaneParams = {
  cwd?: string;
  rootDir?: string;
};

const MAX_RENDER_HISTORY_CHARS = 200_000;

export class TerminalPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private paneId = "";
  private rootDir = "";
  private cwd = "";
  private rootKey: string | null = null;
  private runtimeId: string | null = null;
  private history = "";
  private roots: TerminalRootStatus[] = [];

  private commandInput?: HTMLInputElement;
  private outputEl?: HTMLElement;
  private summaryEl?: HTMLElement;
  private rootsEl?: HTMLElement;
  private unsubscribeEvent?: () => void;

  constructor(private readonly deps: TerminalPaneRendererDependencies) {
    this.element.className = "terminal-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    this.paneId = params.api.id;
    const input = params.params as TerminalPaneParams;
    this.rootDir = input.rootDir ?? input.cwd ?? ".";
    this.cwd = input.cwd ?? this.rootDir;

    this.element.innerHTML = `
      <div class="terminal-panel__header">
        <div>
          <strong>terminal proof</strong>
          <p class="terminal-panel__summary" data-role="summary">detached · cwd=${this.cwd}</p>
        </div>
        <div class="terminal-panel__actions">
          <button type="button" data-action="create">Create</button>
          <button type="button" data-action="refresh">Refresh</button>
          <button type="button" data-action="roots">Roots</button>
          <button type="button" data-action="kill">Kill</button>
        </div>
      </div>
      <pre class="terminal-panel__output" data-role="output"></pre>
      <form class="terminal-panel__input-row" data-role="command-form">
        <input class="terminal-panel__input" name="command" type="text" spellcheck="false" placeholder="help" />
        <button type="submit">Send</button>
      </form>
      <div class="terminal-panel__roots" data-role="roots"></div>
    `;

    this.commandInput = this.element.querySelector<HTMLInputElement>(".terminal-panel__input")!;
    this.outputEl = this.element.querySelector<HTMLElement>('[data-role="output"]')!;
    this.summaryEl = this.element.querySelector<HTMLElement>('[data-role="summary"]')!;
    this.rootsEl = this.element.querySelector<HTMLElement>('[data-role="roots"]')!;

    this.element.querySelector<HTMLFormElement>('[data-role="command-form"]')!.addEventListener("submit", (event) => {
      event.preventDefault();
      const command = this.commandInput!.value.trim();
      if (!command) {
        return;
      }

      this.commandInput!.value = "";
      void this.send(command);
    });

    this.element.querySelector<HTMLButtonElement>('[data-action="create"]')!.addEventListener("click", () => {
      void this.createRuntime();
    });

    this.element.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.addEventListener("click", () => {
      void this.refreshHistory();
    });

    this.element.querySelector<HTMLButtonElement>('[data-action="roots"]')!.addEventListener("click", () => {
      void this.refreshRoots();
    });

    this.element.querySelector<HTMLButtonElement>('[data-action="kill"]')!.addEventListener("click", () => {
      void this.kill();
    });

    this.unsubscribeEvent = this.deps.terminalEvents.onEvent((event) => {
      this.handleTerminalEvent(event);
    });

    this.renderSummary(null);
    void this.refreshRoots();
  }

  dispose() {
    this.unsubscribeEvent?.();
  }

  private async createRuntime() {
    if (this.runtimeId) {
      this.renderError(new Error(`Terminal pane '${this.paneId}' already has an attached runtime`));
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/create`, {
        cwd: this.cwd,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      this.applyCreateResult(result.value as TerminalCreateResult);
      await this.refreshRoots();
    } catch (error) {
      this.renderError(error);
    }
  }

  private async send(command: string) {
    if (!this.rootKey || !this.runtimeId) {
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/write`, {
        data: command
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      const writeResult = result.value as TerminalWriteResult;
      if (writeResult.history.length > 0) {
        this.history = clampHistory(writeResult.history);
        this.renderHistory();
      }
      this.renderSummary(writeResult.terminal ?? null);
      await this.refreshRoots();
    } catch (error) {
      this.renderError(error);
    }
  }

  private async refreshHistory() {
    if (!this.rootKey || !this.runtimeId) {
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/history`);
      if (!result.ok) {
        throw new Error(result.error);
      }

      this.history = clampHistory((result.value as TerminalHistoryResult).data);
      this.renderHistory();
    } catch (error) {
      this.renderError(error);
    }
  }

  private async refreshRoots() {
    try {
      this.roots = await this.deps.terminalEvents.listRoots();
      this.renderRoots();
    } catch (error) {
      this.renderError(error);
    }
  }

  private async kill() {
    if (!this.rootKey || !this.runtimeId) {
      this.renderSummary(null);
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/kill`);
      if (!result.ok) {
        throw new Error(result.error);
      }

      this.rootKey = null;
      this.runtimeId = null;
      this.deps.onRuntimeStateChange(this.paneId, {
        cwd: this.cwd,
        rootKey: null,
        runtimeId: null,
        summary: null
      });
      this.renderSummary((result.value as TerminalKillResult).terminal);
      await this.refreshHistory();
      await this.refreshRoots();
    } catch (error) {
      this.renderError(error);
    }
  }

  private applyCreateResult(result: TerminalCreateResult) {
    this.rootKey = result.rootKey;
    this.runtimeId = result.runtimeId;
    this.cwd = result.terminal.cwd;
    this.history = result.history;
    this.deps.onRuntimeStateChange(this.paneId, {
      cwd: this.cwd,
      rootKey: this.rootKey,
      runtimeId: this.runtimeId,
      summary: result.terminal
    });
    this.renderHistory();
    this.renderSummary(result.terminal);
  }

  private renderHistory() {
    if (this.outputEl) {
      this.outputEl.textContent = this.history;
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }
  }

  private renderSummary(summary: TerminalRuntimeSummary | null) {
    if (!this.summaryEl) {
      return;
    }

    if (!summary) {
      this.summaryEl.textContent = `detached · cwd=${this.cwd}`;
      return;
    }

    this.summaryEl.textContent =
      `${summary.alive ? "alive" : "closed"} · root=${summary.rootKey} · runtime=${summary.runtimeId} · cwd=${summary.cwd}`;
  }

  private renderRoots() {
    if (!this.rootsEl) {
      return;
    }

    this.rootsEl.replaceChildren(
      ...this.roots.map((root) => {
        const item = document.createElement("div");
        item.className = "terminal-panel__root-item";
        item.textContent = `${root.rootKey} · ${root.runtimeCount} runtimes · ${root.rootDir}`;
        return item;
      })
    );
  }

  private renderError(error: unknown) {
    if (this.summaryEl) {
      this.summaryEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private handleTerminalEvent(event: TerminalRuntimeEvent) {
    if (event.paneId !== this.paneId) {
      return;
    }

    if (event.type === "output") {
      this.history = clampHistory(this.history + event.data);
      this.renderHistory();
      return;
    }

    if (event.type === "state") {
      this.rootKey = event.terminal.rootKey;
      this.runtimeId = event.terminal.runtimeId;
      this.cwd = event.terminal.cwd;
      this.deps.onRuntimeStateChange(this.paneId, {
        cwd: this.cwd,
        rootKey: this.rootKey,
        runtimeId: this.runtimeId,
        summary: event.terminal
      });
      this.renderSummary(event.terminal);
      return;
    }

    if (event.type === "removed") {
      this.rootKey = null;
      this.runtimeId = null;
      this.deps.onRuntimeStateChange(this.paneId, {
        cwd: this.cwd,
        rootKey: null,
        runtimeId: null,
        summary: null
      });
      this.renderSummary(null);
    }
  }
}

function clampHistory(history: string) {
  return history.length > MAX_RENDER_HISTORY_CHARS
    ? history.slice(-MAX_RENDER_HISTORY_CHARS)
    : history;
}
