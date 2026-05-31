import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveFlmuxPaths } from "../../src/main/flmuxPaths";
import { stopOwnedPtydDaemonsForRootDir } from "./ptydCleanup";
import { waitFor } from "./waitFor";

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface AppProcessHandle {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout: string;
  stderr: string;
  /** Per-launch install root (mkdtemp). Everything flmux writes lives under
   * `<rootDir>/.flmux/` — CEF user data, session snapshot, auth store,
   * ptyd lock. Deleted recursively at cleanup. */
  rootDir: string;
}

export async function cleanupAppHandles(appHandles: AppProcessHandle[]) {
  while (appHandles.length > 0) {
    const handle = appHandles.pop();
    if (!handle) {
      continue;
    }

    await killProcessTree(handle.process);
    // Stop the ptyd daemon spawned for this rootDir before wiping the
    // tree — killProcessTree only covers the app's child tree, and ptyd
    // is spawned detached so it'd survive otherwise.
    try {
      await stopOwnedPtydDaemonsForRootDir(handle.rootDir);
    } catch {
      /* best-effort */
    }
    try {
      // maxRetries handles the Windows CEF-cache EBUSY window — after
      // killProcessTree, CEF native workers may still hold locks on
      // `<rootDir>/.flmux/cef-userdata/` for a few hundred ms.
      rmSync(handle.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Best-effort; leftover temp dirs are harmless (cleaned on reboot).
    }
  }
}

export function allocateFlmuxRootDir(label: string): string {
  return mkdtempSync(resolve(tmpdir(), `flmux-${label}-`));
}

export function launchFlmuxApp(remoteDebuggingPort: number, rootDir?: string): AppProcessHandle {
  const resolvedRootDir = rootDir ?? allocateFlmuxRootDir("root");
  const appProcess = Bun.spawn({
    cmd: [resolveBunCommand(), "run", "dev"],
    cwd: resolve(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      // CDP (/json/list driving below) is CEF-only; default Windows engine is WebView2.
      BUNITE_ENGINE: "cef",
      BUNITE_REMOTE_DEBUGGING_PORT: String(remoteDebuggingPort),
      FLMUX_DEV_MODE: "1",
      FLMUX_HIDDEN_WINDOW: "1",
      FLMUX_ROOT_DIR: resolvedRootDir
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  return createAppProcessHandle(appProcess, resolvedRootDir);
}

export function launchFlmuxWebApp(options: { rootDir: string }): AppProcessHandle {
  const appProcess = Bun.spawn({
    cmd: [resolveBunCommand(), "run", "dev", "--", "--web"],
    cwd: resolve(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      FLMUX_DEV_MODE: "1",
      FLMUX_ROOT_DIR: options.rootDir
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  return createAppProcessHandle(appProcess, options.rootDir);
}

/** Resolve the session snapshot file a launched app will read/write. */
export function resolveLaunchSessionFile(rootDir: string): string {
  return resolveFlmuxPaths(rootDir).desktopSessionFile;
}

/** Resolve the auth dir a launched web app will read/write. */
export function resolveLaunchAuthDir(rootDir: string): string {
  return resolveFlmuxPaths(rootDir).authDir;
}

export async function waitForMainTarget(port: number, label: string) {
  return waitFor(
    async () => {
      const targets = await fetchTargets(port);
      return targets.find((target) => target.url.endsWith("/") && target.webSocketDebuggerUrl) ?? null;
    },
    { timeoutMs: 30_000, intervalMs: 500, label }
  );
}

export async function waitForSingleClientId(origin: string, label: string) {
  return waitFor(
    async () => {
      const clients = await fetchJson<{
        ok: true;
        clients: Array<{ authorityClientId: string }>;
      }>(`${origin}/api/clients`);
      return clients.clients[0]?.authorityClientId ?? null;
    },
    { timeoutMs: 20_000, intervalMs: 250, label }
  );
}

export async function waitForWebOrigin(handle: AppProcessHandle, label: string) {
  const matched = await waitFor(
    async () => {
      const match = /\[flmux\] web origin: (http:\/\/127\.0\.0\.1:\d+)/.exec(handle.stdout);
      return match ? { origin: match[1] } : null;
    },
    { timeoutMs: 30_000, intervalMs: 100, label }
  );

  return matched;
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

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method: "POST",
    headers: {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
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

async function killProcessTree(processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">) {
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

function resolveAppInstallRoot() {
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

export async function stopAppWorkspaceDaemons() {
  await stopOwnedPtydDaemonsForRootDir(resolveAppInstallRoot());
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}

export { waitFor };

function createAppProcessHandle(process: Bun.Subprocess<"ignore", "pipe", "pipe">, rootDir: string): AppProcessHandle {
  const handle: AppProcessHandle = {
    process,
    stdout: "",
    stderr: "",
    rootDir
  };

  void pumpStream(process.stdout, (chunk) => {
    handle.stdout += chunk;
  });
  void pumpStream(process.stderr, (chunk) => {
    handle.stderr += chunk;
  });

  return handle;
}

async function pumpStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) {
      onChunk(tail);
    }
  } catch {}
}
