import { resolve } from "node:path";
import { stopOwnedPtydDaemonsForRootDir } from "./ptydCleanup";
import { waitFor } from "./waitFor";

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface AppProcessHandle {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
}

export async function cleanupAppHandles(appHandles: AppProcessHandle[]) {
  while (appHandles.length > 0) {
    const handle = appHandles.pop();
    if (!handle) {
      continue;
    }

    await killProcessTree(handle.process);
  }
}

export function launchFlmuxApp(remoteDebuggingPort: number, sessionFile?: string): AppProcessHandle {
  const appProcess = Bun.spawn({
    cmd: [resolveBunCommand(), "run", "dev"],
    cwd: resolve(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      BUNITE_REMOTE_DEBUGGING_PORT: String(remoteDebuggingPort),
      FLMUX_DEV_MODE: "1",
      FLMUX_HIDDEN_WINDOW: "1",
      ...(sessionFile ? { FLMUX_SESSION_FILE: sessionFile } : {})
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  return { process: appProcess };
}

export async function waitForMainTarget(port: number, label: string) {
  return waitFor(async () => {
    const targets = await fetchTargets(port);
    return targets.find((target) => target.url.endsWith("/") && target.webSocketDebuggerUrl) ?? null;
  }, { timeoutMs: 30_000, intervalMs: 500, label });
}

export async function waitForSingleClientId(origin: string, label: string) {
  return waitFor(async () => {
    const clients = await fetchJson<{
      ok: true;
      clients: Array<{ clientId: string }>;
    }>(`${origin}/api/clients`);
    return clients.clients[0]?.clientId ?? null;
  }, { timeoutMs: 20_000, intervalMs: 250, label });
}

export async function fetchTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000)
  });
  if (!response.ok) {
    throw new Error(`CDP target list failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<CdpTarget[]>;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function connectCdp(url: string) {
  const websocket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to connect to CDP target ${url}`));
    };
    const cleanup = () => {
      websocket.removeEventListener("open", onOpen);
      websocket.removeEventListener("error", onError);
    };

    websocket.addEventListener("open", onOpen);
    websocket.addEventListener("error", onError);
  });

  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.id !== "number") {
      return;
    }

    const callback = pending.get(message.id);
    if (!callback) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      callback.reject(new Error(message.error.message ?? "Unknown CDP error"));
      return;
    }

    callback.resolve(message.result);
  });

  return {
    async send(method: string, params: Record<string, unknown> = {}) {
      const id = ++nextId;
      const payload = JSON.stringify({
        id,
        method,
        params
      });

      const result = await new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        websocket.send(payload);
      });

      return result;
    },
    async evaluate<T>(expression: string): Promise<T> {
      const result = (await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      })) as {
        result?: { value?: T };
        exceptionDetails?: { text?: string };
      };

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
      }

      return result.result?.value as T;
    },
    async close() {
      websocket.close();
      await new Promise<void>((resolve) => {
        if (websocket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        websocket.addEventListener("close", () => resolve(), { once: true });
      });
    }
  };
}

export async function killProcessTree(processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  if (processHandle.killed || processHandle.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = Bun.spawn({
      cmd: ["taskkill", "/PID", String(processHandle.pid), "/T", "/F"],
      stdout: "ignore",
      stderr: "ignore"
    });
    await killer.exited;
    return;
  }

  processHandle.kill();
  await processHandle.exited;
}

export async function killMainProcessOnly(processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  if (processHandle.killed || processHandle.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = Bun.spawn({
      cmd: ["taskkill", "/PID", String(processHandle.pid), "/F"],
      stdout: "ignore",
      stderr: "ignore"
    });
    await killer.exited;
    return;
  }

  processHandle.kill("SIGKILL");
  await processHandle.exited;
}

export async function stopAppWorkspaceDaemons() {
  await stopOwnedPtydDaemonsForRootDir(resolve(import.meta.dir, "..", "..", "..", "..", "workspace-alpha"));
  await stopOwnedPtydDaemonsForRootDir(resolve(import.meta.dir, "..", "..", "..", "..", "workspace-beta"));
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}

export { waitFor };
