import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview-core";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "../shell/types";
import type {
  TerminalCreateResult,
  TerminalRuntimeEvent,
  TerminalWriteResult
} from "../../shared/terminal";

export interface TerminalPaneRendererDependencies {
  shellModel: ShellModelAPI;
  terminalEvents: Pick<TerminalHostAPI, "subscribe">;
}

type TerminalPaneParams = {
  cwd?: string;
  rootDir?: string;
};

const MAX_RENDER_HISTORY_CHARS = 200_000;

export class TerminalPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private paneId = "";
  private cwd = "";
  private rootKey: string | null = null;
  private runtimeId: string | null = null;
  private history = "";

  private xterm?: XtermTerminal;
  private fitAddon?: FitAddon;
  private xtermReady: Promise<void> | null = null;
  private lastResizeSignature: string | null = null;
  private viewportEl?: HTMLElement;
  private unsubscribeEvent?: () => void;
  private viewportObserver?: ResizeObserver;

  constructor(private readonly deps: TerminalPaneRendererDependencies) {
    this.element.className = "terminal-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    this.paneId = params.api.id;
    const input = params.params as TerminalPaneParams;
    this.cwd = input.cwd ?? input.rootDir ?? ".";

    this.element.innerHTML = `<div class="terminal-panel__viewport" data-role="viewport"></div>`;
    this.viewportEl = this.element.querySelector<HTMLElement>('[data-role="viewport"]')!;

    this.unsubscribeEvent = this.deps.terminalEvents.subscribe((event) => {
      this.handleTerminalEvent(event);
    });

    if (typeof ResizeObserver !== "undefined") {
      this.viewportObserver = new ResizeObserver(() => {
        this.fitTerminal();
      });
      this.viewportObserver.observe(this.viewportEl);
    }

    void this.ensureXterm().then(() => {
      if (!this.runtimeId) {
        void this.attachRuntime();
      }
    });
  }

  layout() {
    this.fitTerminal();
  }

  dispose() {
    this.unsubscribeEvent?.();
    this.viewportObserver?.disconnect();
    this.xterm?.dispose();
  }

  private async ensureXterm() {
    if (this.xtermReady) {
      return this.xtermReady;
    }

    this.xtermReady = (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit")
      ]);

      if (!this.viewportEl || this.xterm) {
        return;
      }

      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: `ui-monospace, "SFMono-Regular", Consolas, monospace`,
        fontSize: 12,
        scrollback: 10_000,
        theme: {
          background: "#04070c",
          foreground: "#d7ffe1",
          selectionBackground: "rgba(136, 214, 201, 0.28)"
        }
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.onData((data) => {
        void this.writeToRuntime(data);
      });
      terminal.onResize(({ cols, rows }) => {
        void this.resizeRuntime(cols, rows);
      });
      terminal.open(this.viewportEl);

      this.xterm = terminal;
      this.fitAddon = fitAddon;
      this.replaceTerminalBuffer();
      this.fitTerminal();
    })().catch((error) => {
      this.writeSystemLine(error instanceof Error ? error.message : String(error));
      throw error;
    });

    return this.xtermReady;
  }

  private async attachRuntime() {
    if (this.runtimeId) {
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/attach`, {
        cwd: this.cwd,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      this.applyAttachResult(result.value as TerminalCreateResult);
      await this.ensureXterm();
      this.fitTerminal();
    } catch (error) {
      this.writeSystemLine(error instanceof Error ? error.message : String(error));
    }
  }

  private async writeToRuntime(data: string) {
    if (!this.rootKey || !this.runtimeId) {
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/write`, {
        data
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      const writeResult = result.value as TerminalWriteResult;
      if (writeResult.history.length > 0) {
        this.history = clampHistory(writeResult.history);
        this.replaceTerminalBuffer();
      }
    } catch (error) {
      this.writeSystemLine(error instanceof Error ? error.message : String(error));
    }
  }

  private async resizeRuntime(cols: number, rows: number) {
    if (!this.rootKey || !this.runtimeId) {
      return;
    }

    const signature = `${cols}x${rows}`;
    if (signature === this.lastResizeSignature) {
      return;
    }

    try {
      const result = await this.deps.shellModel.pathCall(`/panes/${this.paneId}/terminal/resize`, {
        cols,
        rows
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      this.lastResizeSignature = signature;
    } catch (error) {
      this.writeSystemLine(error instanceof Error ? error.message : String(error));
    }
  }

  private applyAttachResult(result: TerminalCreateResult) {
    this.rootKey = result.rootKey;
    this.runtimeId = result.runtimeId;
    this.cwd = result.terminal.cwd;
    this.history = clampHistory(result.history);
    this.lastResizeSignature = null;
    this.replaceTerminalBuffer();
  }

  private fitTerminal() {
    try {
      this.fitAddon?.fit();
    } catch {}
  }

  private replaceTerminalBuffer() {
    if (!this.xterm) {
      return;
    }

    this.xterm.reset();
    if (this.history.length > 0) {
      this.xterm.write(this.history);
    }
  }

  private writeSystemLine(message: string) {
    if (!message) {
      return;
    }

    this.history = clampHistory(`${this.history}${this.history.length > 0 ? "\r\n" : ""}[flmux] ${message}\r\n`);
    this.replaceTerminalBuffer();
  }

  private handleTerminalEvent(event: TerminalRuntimeEvent) {
    if (event.paneId !== this.paneId) {
      return;
    }

    if (event.type === "output") {
      this.history = clampHistory(this.history + event.data);
      this.xterm?.write(event.data);
      return;
    }

    if (event.type === "state") {
      this.rootKey = event.terminal.rootKey;
      this.runtimeId = event.terminal.runtimeId;
      this.cwd = event.terminal.cwd;
      this.fitTerminal();
      return;
    }

    if (event.type === "removed") {
      this.rootKey = null;
      this.runtimeId = null;
      this.lastResizeSignature = null;
      this.writeSystemLine("terminal detached");
    }
  }
}

function clampHistory(history: string) {
  return history.length > MAX_RENDER_HISTORY_CHARS
    ? history.slice(-MAX_RENDER_HISTORY_CHARS)
    : history;
}
