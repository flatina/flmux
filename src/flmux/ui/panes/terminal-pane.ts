import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { FlmuxView } from "../../../types/view";
import { asTerminalRuntimeId } from "../../../lib/ids";
import { sleep } from "../../../lib/timers";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../../../types/terminal";
import type { TerminalPaneParams } from "../../model/pane-params";
import { getHostRpc } from "../../renderer/transport/host-rpc";
import type { HostPushMessage, HostPushPayload, HostRpcMethod, HostRpcParams, HostRpcResult } from "../../rpc/host-rpc";
import { getTerminalTheme } from "../theme";

type TerminalViewParams = Omit<TerminalPaneParams, "kind" | "state">;
type TerminalViewState = {
  startupCommandsConsumed?: boolean;
};

const hostRpc = getHostRpc();

type LegacyTerminalInstance = {
  update?: (nextParams: TerminalViewParams) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

export const terminalView: FlmuxView<TerminalViewParams, TerminalViewState> = {
  async createInstance(context) {
    let mounted: LegacyTerminalInstance | null = null;
    return {
      async mount(host) {
        mounted = await mountTerminalPaneLegacy(host, context);
      },
      async update(nextParams) {
        await mounted?.update?.(nextParams);
      },
      dispose() {
        void mounted?.dispose?.();
        mounted = null;
      }
    };
  }
};

async function mountTerminalPaneLegacy(host: HTMLElement, context: any): Promise<LegacyTerminalInstance> {
  let params = normalizeParams(context.params);
  let startupCommandsConsumed = context.state?.startupCommandsConsumed ?? false;
  let outerVisible = true;
  let paneActive = false;
  let terminalBell = false;
  let terminalLastRuntime: TerminalRuntimeSummary | null = null;
  let terminalLastSize: { cols: number; rows: number } | null = null;
  let terminalAttachPromise: Promise<void> | null = null;
  let terminalAttachAbortController: AbortController | null = null;
  let disposed = false;
  let terminalUnsub: () => void = () => {};
  const mountAbortController = new AbortController();

  const terminalHost = document.createElement("div");
  terminalHost.className = "terminal-host";
  host.replaceChildren(terminalHost);

  const terminal = new Terminal({
    allowTransparency: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: getTerminalTheme(context.getResolvedTheme())
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost);

  const inputDisposable = terminal.onData((data) => {
    fireAndForgetHostRpc("terminal.input", {
      runtimeId: params.runtimeId,
      data
    });
  });
  const handlePointerDown = () => terminal.focus();
  terminalHost.addEventListener("pointerdown", handlePointerDown);

  const visibilityUnsub = context.onVisibilityChange((visible: boolean) => {
    outerVisible = visible;
    if (visible) {
      if (terminalBell) {
        terminalBell = false;
        syncBellTitle();
      }
      requestAnimationFrame(() => {
        if (disposed) {
          return;
        }
        terminal.refresh(0, terminal.rows - 1);
      });
      scheduleTerminalFit();
    }
  });
  const activeUnsub = context.onActiveChange((isActive: boolean) => {
    paneActive = isActive;
    if (isActive && terminalBell) {
      terminalBell = false;
      syncBellTitle();
    }
  });
  const dimensionsUnsub = context.onDimensionsChange(() => scheduleTerminalFit());
  void attachTerminalEvents();
  const themeUnsub = context.onThemeChange((theme: "dark" | "light") => {
    terminal.options.theme = getTerminalTheme(theme);
  });
  const bellDisposable = terminal.onBell(() => {
    if (!outerVisible || !paneActive) {
      terminalBell = true;
      syncBellTitle();
    }
    playBellSound();
  });

  safeSetPaneTitle(getTerminalBaseTitle(params.shell));

  // Fit first so the pty gets the real container dimensions, not 120x32 defaults.
  // terminal.open() has already attached to DOM, so fitAddon can measure cell metrics.
  requestAnimationFrame(() => {
    if (disposed) {
      return;
    }
    fitTerminal();
    void ensureTerminalRuntime();
    terminal.focus();
  });

  return {
    async update(nextParams) {
      const next = normalizeParams(nextParams);
      const runtimeChanged = next.runtimeId !== params.runtimeId;
      params = next;
      if (runtimeChanged) {
        startupCommandsConsumed = false;
        terminalLastRuntime = null;
        cancelTerminalAttach();
      }
      safeSetPaneTitle(getTerminalBaseTitle(terminalLastRuntime?.shell ?? params.shell));
      if (runtimeChanged) {
        terminal.reset();
        terminalLastSize = null;
        await ensureTerminalRuntime();
      } else {
        scheduleTerminalFit();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      mountAbortController.abort();
      cancelTerminalAttach();
      inputDisposable.dispose();
      terminalHost.removeEventListener("pointerdown", handlePointerDown);
      visibilityUnsub();
      activeUnsub();
      dimensionsUnsub();
      terminalUnsub();
      themeUnsub();
      bellDisposable.dispose();
      terminal.dispose();
      context.setHeaderActions([]);
      host.replaceChildren();
    }
  } satisfies LegacyTerminalInstance;

  function handleTerminalEvent(event: TerminalRuntimeEvent): void {
    if (disposed) {
      return;
    }

    const runtimeId = params.runtimeId;
    if (event.type === "output") {
      if (event.runtimeId !== runtimeId) {
        return;
      }
      terminal.write(event.data);
      return;
    }

    if (event.type === "state") {
      if (event.runtime.runtimeId !== runtimeId) {
        return;
      }

      const wasRunning = terminalLastRuntime?.status === "running";
      terminalLastRuntime = event.runtime;
      if (wasRunning && event.runtime.status === "exited") {
        terminal.writeln(
          `\r\n[flmux] process exited${event.runtime.exitCode === null ? "" : ` (${event.runtime.exitCode})`}`
        );
      }
      if (event.runtime.status === "running") {
        safeSetPaneTitle(getTerminalBaseTitle(event.runtime.shell));
        scheduleTerminalFit();
      }
      return;
    }

    if (event.runtimeId !== runtimeId) {
      return;
    }

    terminalLastRuntime = null;
    const exitSuffix = event.exitCode === null ? "" : ` (${event.exitCode})`;
    terminal.writeln(`\r\n[flmux] runtime removed${exitSuffix}`);
  }

  async function ensureTerminalRuntime(): Promise<void> {
    if (terminalAttachPromise) {
      return terminalAttachPromise;
    }
    if (disposed) {
      return;
    }

    const attachParams = params;
    const cols = terminalLastSize?.cols ?? 120;
    const rows = terminalLastSize?.rows ?? 32;
    const startupCommands =
      startupCommandsConsumed || !attachParams.startupCommands?.length ? undefined : attachParams.startupCommands;
    const attachAbortController = new AbortController();
    terminalAttachAbortController = attachAbortController;
    const signal = attachAbortController.signal;

    const attachPromise = requestHostRpc("terminal.get", { runtimeId: attachParams.runtimeId }, signal)
      .then(async (existing) => {
        if (!canApplyTerminalAttach(attachParams.runtimeId, signal)) {
          return;
        }

        if (existing.runtime) {
          const history = await requestHostRpc("terminal.history", { runtimeId: attachParams.runtimeId }, signal);
          if (!canApplyTerminalAttach(attachParams.runtimeId, signal)) {
            return;
          }

          terminalLastRuntime = existing.runtime;
          if (history.data) {
            terminal.write(history.data);
          }
          safeSetPaneTitle(getTerminalBaseTitle(existing.runtime.shell));
          clearStartupCommandsIfNeeded(attachParams.startupCommands);
          return;
        }

        const created = await requestHostRpc(
          "terminal.create",
          {
            runtimeId: attachParams.runtimeId,
            paneId: context.paneId,
            cwd: attachParams.cwd,
            shell: attachParams.shell,
            renderer: attachParams.renderer,
            cols,
            rows,
            workspaceRoot: context.workspaceRoot,
            webPort: context.webPort,
            startupCommands
          },
          signal
        );
        if (!canApplyTerminalAttach(attachParams.runtimeId, signal)) {
          return;
        }

        terminalLastRuntime = created.terminal;
        safeSetPaneTitle(getTerminalBaseTitle(created.terminal.shell));
        clearStartupCommandsIfNeeded(attachParams.startupCommands);
      })
      .catch((error) => {
        if (isAbortError(error) || disposed) {
          return;
        }
        terminal.writeln(
          `\r\n[flmux] failed to start runtime: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (terminalAttachPromise === attachPromise) {
          terminalAttachPromise = null;
        }
        if (terminalAttachAbortController === attachAbortController) {
          terminalAttachAbortController = null;
        }
      });

    terminalAttachPromise = attachPromise;
    return attachPromise;
  }

  function scheduleTerminalFit(): void {
    if (disposed) {
      return;
    }

    requestAnimationFrame(() => {
      if (disposed) {
        return;
      }
      fitTerminal();
    });
  }

  function fitTerminal(): void {
    if (disposed) {
      return;
    }

    try {
      fitAddon.fit();
    } catch {
      return;
    }

    const nextSize = {
      cols: terminal.cols,
      rows: terminal.rows
    };
    if (nextSize.cols <= 0 || nextSize.rows <= 0) {
      return;
    }
    if (terminalLastSize && terminalLastSize.cols === nextSize.cols && terminalLastSize.rows === nextSize.rows) {
      return;
    }

    terminalLastSize = nextSize;
    if (!terminalLastRuntime || terminalLastRuntime.status !== "running") {
      return;
    }

    fireAndForgetHostRpc("terminal.resize", {
      runtimeId: params.runtimeId,
      cols: nextSize.cols,
      rows: nextSize.rows
    });
  }

  function clearStartupCommandsIfNeeded(startupCommands: string[] | undefined): void {
    if (disposed || startupCommandsConsumed || !startupCommands?.length) {
      return;
    }

    startupCommandsConsumed = true;
    context.setState({ startupCommandsConsumed: true });
  }

  function syncBellTitle(): void {
    const current = readPaneTitle();
    if (terminalBell) {
      if (!current.startsWith("\u{1F514} ")) {
        safeSetPaneTitle(`\u{1F514} ${current}`);
      }
    } else if (current.startsWith("\u{1F514} ")) {
      safeSetPaneTitle(current.slice(3));
    }
  }

  async function attachTerminalEvents(): Promise<void> {
    try {
      terminalUnsub = await subscribeHostMessage(
        "terminal.event",
        (event) => handleTerminalEvent(event),
        mountAbortController.signal
      );
      if (disposed) {
        terminalUnsub();
        terminalUnsub = () => {};
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      // best effort
    }
  }

  function safeSetPaneTitle(title: string): void {
    if (disposed) {
      return;
    }

    try {
      context.curPane.title = title;
    } catch {
      // best effort until Dockview fully registers the panel
    }
  }

  function cancelTerminalAttach(): void {
    terminalAttachAbortController?.abort();
    terminalAttachAbortController = null;
    terminalAttachPromise = null;
  }

  function canApplyTerminalAttach(runtimeId: TerminalViewParams["runtimeId"], signal: AbortSignal): boolean {
    return !disposed && !signal.aborted && params.runtimeId === runtimeId;
  }

  function fireAndForgetHostRpc<Method extends HostRpcMethod>(method: Method, rpcParams: HostRpcParams<Method>): void {
    void requestHostRpc(method, rpcParams, mountAbortController.signal).catch((error) => {
      if (!isAbortError(error)) {
        // best effort fire-and-forget RPC
      }
    });
  }

  function readPaneTitle(): string {
    try {
      return String(context.curPane.title);
    } catch {
      return getTerminalBaseTitle(terminalLastRuntime?.shell ?? params.shell);
    }
  }
}

function normalizeParams(value: unknown): TerminalViewParams {
  const raw = value as Partial<TerminalViewParams> | null | undefined;
  return {
    runtimeId: typeof raw?.runtimeId === "string" ? asTerminalRuntimeId(raw.runtimeId) : asTerminalRuntimeId(""),
    cwd: typeof raw?.cwd === "string" ? raw.cwd : null,
    shell: typeof raw?.shell === "string" ? raw.shell : null,
    renderer: raw?.renderer === "ghostty" ? "ghostty" : "xterm",
    startupCommands: Array.isArray(raw?.startupCommands)
      ? raw.startupCommands.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : undefined
  };
}

function getTerminalBaseTitle(shell: string | null): string {
  const shellName = shell ? fileNameFromPath(shell).toLowerCase() : "";
  switch (shellName) {
    case "pwsh":
    case "pwsh.exe":
      return "PowerShell 7";
    case "powershell":
    case "powershell.exe":
      return "Windows PowerShell";
    case "cmd":
    case "cmd.exe":
      return "Command Prompt";
    default:
      return shell ? fileNameFromPath(shell) : "Terminal";
  }
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "Untitled";
  }

  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function playBellSound(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.02;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
    oscillator.onended = () => void context.close();
  } catch {
    // ignore
  }
}

async function requestHostRpc<Method extends HostRpcMethod>(
  method: Method,
  params: HostRpcParams<Method>,
  signal?: AbortSignal
): Promise<HostRpcResult<Method>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    throwIfAborted(signal);
    try {
      return await hostRpc.request(method, params);
    } catch (error) {
      throwIfAborted(signal);
      if (!isRpcNotReadyError(error) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(50, signal);
    }
  }
}

async function subscribeHostMessage<Message extends HostPushMessage>(
  message: Message,
  handler: (payload: HostPushPayload<Message>) => void,
  signal?: AbortSignal
): Promise<() => void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    throwIfAborted(signal);
    try {
      return hostRpc.subscribe?.(message, handler as any) ?? (() => {});
    } catch (error) {
      throwIfAborted(signal);
      if (!isRpcNotReadyError(error) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(50, signal);
    }
  }
}

function isRpcNotReadyError(error: unknown): boolean {
  return error instanceof Error && /RPC is not ready/i.test(error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

