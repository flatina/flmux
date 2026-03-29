import { resolve } from "node:path";
import { callJsonRpcIpc } from "../../src/lib/ipc/json-rpc-ipc";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { cleanupStaleSessions, listRecoverablePtydSessions, resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, sleep, waitForApp } from "./helpers";

const projectRoot = resolve(import.meta.dir, "../..");
const electrobunBin = resolve(projectRoot, "node_modules/.bin/electrobun");

async function main() {
  await cleanupStaleSessions();
  const client = await waitForApp();
  await sleep(2000);

  const identify = await client.call("system.identify", undefined);
  const originalSession = await resolveSession();
  await cleanupOtherRecoverablePtyds(originalSession.sessionId);
  const originalSummary = await client.call("app.summary", undefined);
  const originalTerminal = originalSummary.panes.find((pane) => pane.kind === "terminal");
  if (!originalTerminal?.runtimeId) {
    throw new Error("no terminal runtime to recover");
  }

  const ptydEndpoint = { ipcPath: getPtydControlIpcPath(originalSession.sessionId) };
  const beforeCrash = await callJsonRpcIpc<{ terminals: Array<{ runtimeId: string }> }>(
    ptydEndpoint,
    "terminal.list",
    undefined
  );
  assert(
    beforeCrash.terminals.some((terminal) => terminal.runtimeId === originalTerminal.runtimeId),
    "ptyd lists the original terminal before crash"
  );

  Bun.spawnSync(["taskkill", "/PID", String(identify.pid), "/F"], {
    cwd: projectRoot,
    stdout: "ignore",
    stderr: "ignore"
  });
  await sleep(1500);

  const orphanStatus = await callJsonRpcIpc<{ ok: true; sessionId: string; terminalCount: number }>(
    ptydEndpoint,
    "daemon.status",
    undefined
  );
  assert(orphanStatus.ok, "orphan ptyd still responds after app crash");
  assert(orphanStatus.sessionId === originalSession.sessionId, "orphan ptyd keeps the original session id");
  assert(orphanStatus.terminalCount >= 1, "orphan ptyd still has terminals");

  const replacement = Bun.spawn([electrobunBin, "dev", "--", "--orphan-ptyd=recover"], {
    cwd: projectRoot,
    env: { ...process.env, FLMUX_FRESH: "1", FLMUX_ORPHAN_PTYD: "recover" },
    detached: true,
    stdout: "ignore",
    stderr: "ignore"
  });
  let keepReplacementRunning = false;

  try {
    await cleanupStaleSessions();
    await sleep(1000);
    await waitForApp(15000, 250);
    const recoveredSession = await resolveSession();

    assert(
      recoveredSession.sessionId === originalSession.sessionId,
      "session discovery resolves the recovered orphan session"
    );

    const afterRecovery = await callJsonRpcIpc<{ terminals: Array<{ runtimeId: string }> }>(
      ptydEndpoint,
      "terminal.list",
      undefined
    );
    assert(
      afterRecovery.terminals.some((terminal) => terminal.runtimeId === originalTerminal.runtimeId),
      "original terminal runtime survives orphan recovery"
    );
    keepReplacementRunning = true;
  } finally {
    if (!keepReplacementRunning) {
      try {
        const recoveredSession = await resolveSession(originalSession.sessionId);
        const recoveredClient = createAppRpcClient({ ipcPath: recoveredSession.ipcPath });
        await recoveredClient.call("app.quit", undefined);
      } catch {
        // best effort cleanup
      }
      replacement.kill();
      await replacement.exited;
    }
  }
}

async function cleanupOtherRecoverablePtyds(currentSessionId: string): Promise<void> {
  const recoverable = await listRecoverablePtydSessions();
  for (const session of recoverable) {
    if (session.sessionId === currentSessionId) {
      continue;
    }

    try {
      await callJsonRpcIpc(
        {
          ipcPath: session.controlIpcPath
        },
        "daemon.stop",
        undefined,
        1000
      );
    } catch {
      // best effort cleanup for test isolation
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
