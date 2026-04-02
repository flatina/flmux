import { resolve } from "node:path";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { listRecoverablePtydSessions } from "../../src/flmux/client/session-discovery";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { callJsonRpcIpc } from "../../src/lib/ipc/json-rpc-ipc";
import type { SessionId } from "../../src/lib/ids";
import { assert, sleep, waitForApp } from "./helpers";

const projectRoot = resolve(import.meta.dir, "../..");
const QUIT_TIMEOUT_MS = 5_000;
const PTYD_STOP_TIMEOUT_MS = 5_000;

async function main() {
  const client = await waitForApp(5_000);
  const identify = await client.call("system.identify", undefined);
  const sessionId = identify.sessionId as SessionId;

  const beforeRecoverableIds = new Set(
    (await listRecoverablePtydSessions()).map((s) => s.sessionId)
  );

  // Verify ptyd is alive before quit
  await callJsonRpcIpc(
    { ipcPath: getPtydControlIpcPath(sessionId) },
    "daemon.status",
    undefined,
    1_000
  );

  await client.call("app.quit", undefined, 5_000);

  const ptydStopped = await waitForPtydToStop(sessionId, PTYD_STOP_TIMEOUT_MS);
  assert(ptydStopped, "ptyd control socket stops after clean quit");

  const recoverable = await waitForLingeringRecoverableSession(
    sessionId,
    beforeRecoverableIds,
    PTYD_STOP_TIMEOUT_MS
  );
  assert(!recoverable, "clean quit does not leave a recoverable ptyd session");

  console.log("\nPtyd clean quit checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function waitForLingeringRecoverableSession(
  sessionId: SessionId,
  existingRecoverableIds: Set<string>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recoverable = await listRecoverablePtydSessions();
    const isNew = recoverable.some(
      (s) => s.sessionId === sessionId && !existingRecoverableIds.has(s.sessionId)
    );
    if (!isNew) return false;
    await sleep(200);
  }
  return true;
}

async function waitForPtydToStop(sessionId: SessionId, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await callJsonRpcIpc(
        { ipcPath: getPtydControlIpcPath(sessionId) },
        "daemon.status",
        undefined,
        600
      );
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}
