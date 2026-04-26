import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer } from "dockview-core";
import type { TerminalHostAPI } from "../terminalHost";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import type { TerminalCreateResult, TerminalRuntimeEvent, TerminalWriteResult } from "@flmux/core/terminal/types";

interface TerminalPaneRendererDependencies {
  shellModel: ShellModelAPI;
  terminalEvents: Pick<TerminalHostAPI, "subscribe">;
}

type TerminalPaneParams = {
  cwd?: string;
  rootDir?: string;
};

const MAX_RENDER_HISTORY_CHARS = 200_000;
const BELL_PREFIX = "\u{1F514} ";

// ANSI 16-color palettes tuned from VS Code Dark+ / Light+ (matching what
// most users see in other terminals). Without explicit values xterm falls
// back to its built-in defaults, which on the light background render
// bright yellow / bright white at near-invisible contrast.
const XTERM_DARK_THEME = {
  background: "#04070c",
  foreground: "#d7ffe1",
  cursor: "#ffad5a",
  cursorAccent: "#04070c",
  selectionBackground: "rgba(136, 214, 201, 0.28)",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5"
} as const;

const XTERM_LIGHT_THEME = {
  background: "#f7f9fc",
  foreground: "#1f2937",
  cursor: "#d4820f",
  cursorAccent: "#f7f9fc",
  selectionBackground: "rgba(212, 130, 15, 0.22)",
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5"
} as const;

function currentXtermTheme() {
  const mode = document.documentElement.dataset.theme;
  if (mode === "light") return XTERM_LIGHT_THEME;
  if (mode === "dark") return XTERM_DARK_THEME;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? XTERM_LIGHT_THEME : XTERM_DARK_THEME;
}

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
  private themeChangeListener?: () => void;
  private pointerDownListener?: (event: PointerEvent) => void;
  private panelApi?: DockviewPanelApi;
  private bellActive = false;
  private visibilityDisposable?: { dispose(): void };
  private activeDisposable?: { dispose(): void };
  private wasAlive: boolean | null = null;

  constructor(private readonly deps: TerminalPaneRendererDependencies) {
    this.element.className = "terminal-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    this.paneId = params.api.id;
    this.panelApi = params.api;
    const input = params.params as TerminalPaneParams;
    this.cwd = input.cwd ?? input.rootDir ?? ".";

    this.element.innerHTML = `<div class="terminal-panel__viewport" data-role="viewport"></div>`;
    this.viewportEl = this.element.querySelector<HTMLElement>('[data-role="viewport"]')!;

    this.unsubscribeEvent = this.deps.terminalEvents.subscribe((event) => {
      this.handleTerminalEvent(event);
    });

    this.visibilityDisposable = params.api.onDidVisibilityChange((event) => {
      if (event.isVisible) this.clearBell();
    });
    this.activeDisposable = params.api.onDidActiveChange((event) => {
      if (event.isActive) this.clearBell();
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
    // Strip bell prefix before dockview persists the title.
    this.clearBell();
    this.unsubscribeEvent?.();
    this.viewportObserver?.disconnect();
    this.visibilityDisposable?.dispose();
    this.activeDisposable?.dispose();
    if (this.themeChangeListener) {
      document.removeEventListener("flmux-theme-change", this.themeChangeListener);
    }
    if (this.pointerDownListener && this.viewportEl) {
      this.viewportEl.removeEventListener("pointerdown", this.pointerDownListener);
    }
    this.xterm?.dispose();
  }

  private setBell() {
    if (this.bellActive || !this.panelApi) return;
    this.bellActive = true;
    const current = this.panelApi.title ?? "";
    if (!current.startsWith(BELL_PREFIX)) {
      this.panelApi.setTitle(`${BELL_PREFIX}${current}`);
    }
  }

  private clearBell() {
    if (!this.bellActive || !this.panelApi) return;
    this.bellActive = false;
    const current = this.panelApi.title ?? "";
    if (current.startsWith(BELL_PREFIX)) {
      this.panelApi.setTitle(current.slice(BELL_PREFIX.length));
    }
  }

  private async ensureXterm() {
    if (this.xtermReady) {
      return this.xtermReady;
    }

    this.xtermReady = (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);

      if (!this.viewportEl || this.xterm) {
        return;
      }

      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: `ui-monospace, "SFMono-Regular", Consolas, monospace`,
        fontSize: 12,
        scrollback: 10_000,
        theme: currentXtermTheme()
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.onData((data) => {
        void this.writeToRuntime(data);
      });
      terminal.onResize(({ cols, rows }) => {
        void this.resizeRuntime(cols, rows);
      });

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        if ((!event.ctrlKey && !event.metaKey) || event.altKey) return true;
        const key = event.key.toLowerCase();
        if (key === "c" && terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
          terminal.clearSelection();
          return false;
        }
        if (key === "v") {
          // Suppress xterm's default keydown handling and let the
          // textarea's native `paste` event do the actual paste. A manual
          // `terminal.paste(await readText())` here used to double-fire
          // against the native handler (Ctrl+V pasted twice; right-click
          // paste, which doesn't go through keydown, was unaffected).
          return false;
        }
        return true;
      });

      terminal.open(this.viewportEl);

      this.pointerDownListener = () => terminal.focus();
      this.viewportEl.addEventListener("pointerdown", this.pointerDownListener);

      terminal.onBell(() => {
        if (this.panelApi?.isVisible && this.panelApi?.isActive) return;
        this.setBell();
      });

      this.xterm = terminal;
      this.fitAddon = fitAddon;
      this.themeChangeListener = () => {
        if (!this.xterm) return;
        this.xterm.options.theme = currentXtermTheme();
      };
      document.addEventListener("flmux-theme-change", this.themeChangeListener);
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
        cwd: this.cwd
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
    this.wasAlive = result.terminal.alive;
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
      // Runtime swap: drop carry-over wasAlive before reassigning runtimeId.
      if (event.terminal.runtimeId !== this.runtimeId) {
        this.wasAlive = null;
      }

      this.rootKey = event.terminal.rootKey;
      this.runtimeId = event.terminal.runtimeId;
      this.cwd = event.terminal.cwd;

      const alive = event.terminal.alive;
      if (this.wasAlive === true && alive === false) {
        this.writeSystemLine(`process exited${formatExitSuffix(event.terminal)}`);
      }
      this.wasAlive = alive;

      this.fitTerminal();
      return;
    }

    if (event.type === "removed") {
      this.rootKey = null;
      this.runtimeId = null;
      this.lastResizeSignature = null;
      this.wasAlive = null;
      this.writeSystemLine("terminal detached");
    }
  }
}

function clampHistory(history: string) {
  return history.length > MAX_RENDER_HISTORY_CHARS ? history.slice(-MAX_RENDER_HISTORY_CHARS) : history;
}

function formatExitSuffix(summary: { exitCode?: number | null; signal?: string | null }): string {
  if (typeof summary.exitCode === "number") return ` (${summary.exitCode})`;
  if (typeof summary.signal === "string" && summary.signal.length > 0) return ` (signal: ${summary.signal})`;
  return "";
}
