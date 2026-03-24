import { callJsonRpcIpc } from "../../src/shared/json-rpc-ipc";
import { getPtydControlIpcPath } from "../../src/shared/ipc-paths";
import type { PtydDaemonStatusResult } from "../../src/shared/ptyd-control-plane";
import { resolveSession } from "../../src/cli/session-discovery";
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  await waitForApp();
  const session = await resolveSession();
  const endpoint = { ipcPath: getPtydControlIpcPath(session.sessionId) };
  const deadline = Date.now() + 5_000;
  let status: PtydDaemonStatusResult | null = null;

  while (Date.now() < deadline) {
    status = await callJsonRpcIpc<PtydDaemonStatusResult>(endpoint, "daemon.status", undefined);
    if (status.terminalCount >= 0) {
      break;
    }

    await sleep(100);
  }

  if (!status) {
    throw new Error("daemon.status did not return");
  }

  assert(status.ok === true, "daemon.status responds");
  assert(status.sessionId === session.sessionId, "daemon status targets the current session");
  assert(status.terminalCount >= 0, "daemon status reports terminal count");
}

void main();
