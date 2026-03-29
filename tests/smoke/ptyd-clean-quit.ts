import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { listRecoverablePtydSessions, listSessions } from "../../src/flmux/client/session-discovery";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { callJsonRpcIpc } from "../../src/lib/ipc/json-rpc-ipc";
import type { SessionId } from "../../src/lib/ids";
import { assert, sleep } from "./helpers";

const projectRoot = resolve(import.meta.dir, "../..");
const SESSION_DISCOVERY_TIMEOUT_MS = 20_000;
const QUIT_TIMEOUT_MS = 15_000;
const PTYD_STOP_TIMEOUT_MS = 5_000;

async function main() {
  await stopRecoverablePtyds();
  const beforeSessionIds = new Set((await listSessions()).map((session) => session.sessionId));
  const beforeRecoverableIds = new Set((await listRecoverablePtydSessions()).map((session) => session.sessionId));

  const xdgRoot = resolve(tmpdir(), `flmux-smoke-clean-quit-${Date.now()}`);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: resolve(xdgRoot, ".config"),
    XDG_DATA_HOME: resolve(xdgRoot, ".local", "share"),
    XDG_STATE_HOME: resolve(xdgRoot, ".local", "state"),
    FLMUX_FRESH: "1",
    FLMUX_ORPHAN_PTYD: "exit",
    FLMUX_ROOT: projectRoot
  };
  for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
    mkdirSync(dir, { recursive: true });
  }
  if (process.platform === "win32" && !env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";
  }

  const app = Bun.spawn(["bun", "run", "start", "--", "--orphan-ptyd=exit"], {
    cwd: projectRoot,
    env,
    stdout: "ignore",
    stderr: "ignore"
  });

  let sessionId: SessionId | null = null;
  try {
    const session = await waitForNewSession(beforeSessionIds);
    sessionId = session.sessionId;
    const client = createAppRpcClient({ ipcPath: session.ipcPath });
    await client.call("system.ping", undefined, 5_000);
    await client.call("app.quit", undefined, 5_000);

    const exited = await waitForProcessExit(app, QUIT_TIMEOUT_MS);
    assert(exited, `bun run start exits within ${QUIT_TIMEOUT_MS}ms after app.quit`);

    const ptydStopped = await waitForPtydToStop(sessionId, PTYD_STOP_TIMEOUT_MS);
    assert(ptydStopped, "ptyd control socket stops after clean quit");

    const recoverable = await waitForLingeringRecoverableSession(sessionId, beforeRecoverableIds, PTYD_STOP_TIMEOUT_MS);
    assert(!recoverable, "clean quit does not leave a recoverable ptyd session");

    console.log("\nPtyd clean quit checks passed.");
  } finally {
    await killProcessTree(app.pid);
    if (sessionId) {
      try {
        await callJsonRpcIpc({ ipcPath: getPtydControlIpcPath(sessionId) }, "daemon.stop", undefined, 1_000);
      } catch {
        // best effort cleanup when the bug reproduces
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function waitForNewSession(existingSessionIds: Set<string>) {
  const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sessions = await listSessions();
    const created = sessions.find((session) => !existingSessionIds.has(session.sessionId));
    if (created) {
      return created;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for bun run start to create a new session");
}

async function waitForProcessExit(app: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    app.exited.then(() => true),
    sleep(timeoutMs).then(() => false)
  ]);
}

async function waitForLingeringRecoverableSession(
  sessionId: SessionId,
  existingRecoverableIds: Set<string>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await hasRecoverableSession(sessionId, existingRecoverableIds))) {
      return false;
    }
    await sleep(200);
  }
  return hasRecoverableSession(sessionId, existingRecoverableIds);
}

async function waitForPtydToStop(sessionId: SessionId, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await callJsonRpcIpc({ ipcPath: getPtydControlIpcPath(sessionId) }, "daemon.status", undefined, 600);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
      cwd: projectRoot,
      stdout: "ignore",
      stderr: "ignore"
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

async function stopRecoverablePtyds(): Promise<void> {
  const recoverable = await listRecoverablePtydSessions();
  for (const session of recoverable) {
    try {
      await callJsonRpcIpc({ ipcPath: session.controlIpcPath }, "daemon.stop", undefined, 1_000);
    } catch {
      // best effort cleanup for isolation
    }
  }
}

async function hasRecoverableSession(sessionId: SessionId, existingRecoverableIds: Set<string>): Promise<boolean> {
  const recoverable = await listRecoverablePtydSessions();
  return recoverable.some((session) => session.sessionId === sessionId && !existingRecoverableIds.has(session.sessionId));
}
