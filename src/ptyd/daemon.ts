import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { asPtyDaemonId, asSessionId, type PtyDaemonId, type SessionId, type TerminalRuntimeId } from "../lib/ids";
import { getPtydControlIpcPath, getPtydEventsIpcPath } from "../lib/ipc/ipc-paths";
import { cleanupIpcListenerPath, prepareIpcListenerPath } from "../lib/ipc/ipc-socket";
import { toJsonLine } from "../lib/ipc/json-lines";
import { startJsonRpcIpcServer } from "../lib/ipc/json-rpc-ipc";
import {
  PTYD_PROTOCOL_VERSION,
  type PtydDaemonStatusResult,
  type PtydIdentifyResult,
  type PtydMethod,
  type PtydParams,
  type PtydResult
} from "./control-plane";
import type { TerminalRuntimeEvent } from "../types/terminal";
import { type PtydLockEntry, PtydLockFile } from "./lock-file";
import { resolveAppWorkingDirectory } from "../lib/runtime-paths";
import { TerminalRuntimeManager } from "./terminal-runtime-manager";

const MAX_HISTORY_BYTES = 200_000;

export async function runPtydDaemonProcess(): Promise<void> {
  const daemonId = asPtyDaemonId(crypto.randomUUID());
  const sessionId = asSessionId(process.env.FLMUX_PTYD_SESSION_ID?.trim() || crypto.randomUUID());
  const startedAt = new Date().toISOString();
  const defaultCwd = resolveAppWorkingDirectory();
  const controlIpcPath = getPtydControlIpcPath(sessionId);
  const eventsIpcPath = getPtydEventsIpcPath(sessionId);
  const lockFile = new PtydLockFile(sessionId);
  const subscribers = new Set<Socket>();
  const outputHistory = new Map<TerminalRuntimeId, string>();
  let shuttingDown = false;

  const extraPath = process.env.FLMUX_TERMINAL_PATH?.split(process.platform === "win32" ? ";" : ":").filter(Boolean) ?? [];
  const terminalRuntimeManager = new TerminalRuntimeManager({
    defaultCwd,
    sessionId,
    extraPath,
    pushTerminalEvent: (event) => {
      handleTerminalEvent(event);
    }
  });

  const controlServer = await startJsonRpcIpcServer({
    ipcPath: controlIpcPath,
    invoke: async (method, params) => {
      return invokePtydMethod(method as PtydMethod, params as PtydParams<PtydMethod>, {
        daemonId,
        sessionId,
        controlIpcPath,
        eventsIpcPath,
        startedAt,
        terminalRuntimeManager,
        outputHistory,
        shutdown
      });
    }
  });
  const eventsServer = await startEventStreamServer(eventsIpcPath, terminalRuntimeManager, subscribers);

  const lockEntry: PtydLockEntry = {
    daemonId,
    sessionId,
    pid: process.pid,
    controlIpcPath,
    eventsIpcPath,
    startedAt,
    protocolVersion: PTYD_PROTOCOL_VERSION
  };

  await lockFile.write(lockEntry);
  spawnPtydTrayHelper(controlIpcPath);

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("beforeExit", () => {
    void shutdown();
  });

  function handleTerminalEvent(event: TerminalRuntimeEvent): void {
    if (event.type === "output") {
      const existing = outputHistory.get(event.runtimeId) ?? "";
      const next = `${existing}${event.data}`;
      outputHistory.set(event.runtimeId, next.slice(-MAX_HISTORY_BYTES));
    }

    if (event.type === "removed") {
      outputHistory.delete(event.runtimeId);
    }

    const payload = toJsonLine(event);
    for (const subscriber of subscribers) {
      try {
        subscriber.write(payload);
      } catch {
        subscriber.destroy();
        subscribers.delete(subscriber);
      }
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    try {
      await lockFile.clearIfOwned({
        daemonId,
        pid: process.pid
      });
      await controlServer.stop();
      await stopEventStreamServer(eventsServer, eventsIpcPath, subscribers);
      terminalRuntimeManager.dispose();
    } finally {
      process.exit(0);
    }
  }
}

async function invokePtydMethod<Method extends PtydMethod>(
  method: Method,
  params: PtydParams<Method>,
  context: {
    daemonId: PtyDaemonId;
    sessionId: SessionId;
    controlIpcPath: string;
    eventsIpcPath: string;
    startedAt: string;
    terminalRuntimeManager: TerminalRuntimeManager;
    outputHistory: Map<TerminalRuntimeId, string>;
    shutdown: () => Promise<void>;
  }
): Promise<PtydResult<Method>> {
  switch (method) {
    case "system.ping":
      return { pong: true } as PtydResult<Method>;
    case "system.identify": {
      const result: PtydIdentifyResult = {
        app: "flmux-ptyd",
        daemonId: context.daemonId,
        sessionId: context.sessionId,
        pid: process.pid,
        controlIpcPath: context.controlIpcPath,
        eventsIpcPath: context.eventsIpcPath,
        startedAt: context.startedAt,
        protocolVersion: PTYD_PROTOCOL_VERSION
      };
      return result as PtydResult<Method>;
    }
    case "terminal.list":
      return {
        terminals: context.terminalRuntimeManager.list()
      } as PtydResult<Method>;
    case "terminal.create":
      return context.terminalRuntimeManager.createTerminal(
        params as PtydParams<"terminal.create">
      ) as PtydResult<Method>;
    case "terminal.kill":
      return context.terminalRuntimeManager.killTerminal(params as PtydParams<"terminal.kill">) as PtydResult<Method>;
    case "terminal.input":
      return context.terminalRuntimeManager.input(params as PtydParams<"terminal.input">) as PtydResult<Method>;
    case "terminal.resize":
      return context.terminalRuntimeManager.resize(params as PtydParams<"terminal.resize">) as PtydResult<Method>;
    case "terminal.history": {
      const historyParams = params as PtydParams<"terminal.history">;
      const data = context.outputHistory.get(historyParams.runtimeId) ?? "";
      return {
        runtimeId: historyParams.runtimeId,
        data: typeof historyParams.maxBytes === "number" ? data.slice(-historyParams.maxBytes) : data
      } as PtydResult<Method>;
    }
    case "daemon.stop":
      queueMicrotask(() => {
        void context.shutdown();
      });
      return { ok: true } as PtydResult<Method>;
    case "daemon.status": {
      const result: PtydDaemonStatusResult = {
        ok: true,
        daemonId: context.daemonId,
        sessionId: context.sessionId,
        pid: process.pid,
        controlIpcPath: context.controlIpcPath,
        eventsIpcPath: context.eventsIpcPath,
        startedAt: context.startedAt,
        protocolVersion: PTYD_PROTOCOL_VERSION,
        terminalCount: context.terminalRuntimeManager.list().length
      };
      return result as PtydResult<Method>;
    }
  }
}

async function startEventStreamServer(
  ipcPath: string,
  terminalRuntimeManager: TerminalRuntimeManager,
  subscribers: Set<Socket>
): Promise<Server> {
  await prepareIpcListenerPath(ipcPath);

  const server = createServer((socket) => {
    subscribers.add(socket);
    socket.on("close", () => {
      subscribers.delete(socket);
    });
    socket.on("error", () => {
      subscribers.delete(socket);
      socket.destroy();
    });

    for (const runtime of terminalRuntimeManager.list()) {
      socket.write(toJsonLine({ type: "state", runtime } satisfies TerminalRuntimeEvent));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function stopEventStreamServer(server: Server, ipcPath: string, subscribers: Set<Socket>): Promise<void> {
  for (const subscriber of subscribers) {
    subscriber.destroy();
  }
  subscribers.clear();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  await cleanupIpcListenerPath(ipcPath);
}

function spawnPtydTrayHelper(controlIpcPath: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const shell = Bun.which("pwsh.exe") ?? Bun.which("pwsh") ?? Bun.which("powershell.exe") ?? Bun.which("powershell");
  if (!shell) {
    return false;
  }

  const script = createWindowsTrayScript();
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  try {
    spawn(shell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        FLMUX_PTYD_CONTROL_IPC: controlIpcPath
      }
    }).unref();
    return true;
  } catch {
    return false;
  }
}

function createWindowsTrayScript(): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$controlIpc = $env:FLMUX_PTYD_CONTROL_IPC
if (-not $controlIpc) { exit 0 }
$pipeName = $controlIpc -replace '^\\\\\\\\\\.\\\\pipe\\\\', ''

function Invoke-Rpc($method, $params = $null, $timeoutMs = 1200) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $client.Connect($timeoutMs)
    $writer = New-Object System.IO.StreamWriter($client)
    $reader = New-Object System.IO.StreamReader($client)
    $writer.AutoFlush = $true
    $id = [guid]::NewGuid().ToString()
    $payload = @{ jsonrpc = '2.0'; id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 10
    $writer.WriteLine($payload)
    $line = $reader.ReadLine()
    if (-not $line) { return $null }
    $response = $line | ConvertFrom-Json
    if ($response.error) { throw $response.error.message }
    return $response.result
  }
  finally {
    $client.Dispose()
  }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = 'flmux ptyd'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('flmux ptyd')
$statusItem.Enabled = $false
$stopItem = $menu.Items.Add('Stop ptyd')
$notify.ContextMenuStrip = $menu

function Cleanup-AndExit {
  $timer.Stop()
  $timer.Dispose()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

$stopItem.Add_Click({
  try { Invoke-Rpc 'daemon.stop' $null | Out-Null } catch {}
  Cleanup-AndExit
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  try {
    $status = Invoke-Rpc 'daemon.status' $null
    if (-not $status) { Cleanup-AndExit; return }
    $statusItem.Text = \"Session $($status.sessionId.Substring(0, 8)) | terminals: $($status.terminalCount)\"
    $tooltip = \"flmux ptyd ($($status.terminalCount) terminals)\"
    $notify.Text = $tooltip.Substring(0, [Math]::Min(63, $tooltip.Length))
  }
  catch {
    Cleanup-AndExit
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;
}
