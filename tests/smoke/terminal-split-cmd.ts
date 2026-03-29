import { callJsonRpc } from "../../src/flmux/client/rpc-client";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { assert, runCli, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const session = await resolveSession();
  const ptyd = { ipcPath: getPtydControlIpcPath(session.sessionId) };

  await sleep(3000);

  const before = await client.call("app.summary", undefined);
  const sourceTerminal = before.panes.find((pane) => pane.kind === "terminal");
  if (!sourceTerminal?.runtimeId) {
    throw new Error("no source terminal with runtimeId");
  }

  const existingRuntimeIds = new Set(before.panes.map((pane) => pane.runtimeId).filter(Boolean));
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath,
    FLMUX_PANE_ID: String(sourceTerminal.paneId)
  };

  const split = runCli(
    ["src/flmux/cli/index.ts", "split", "--direction", "right", "--cmd", "flmux summary"],
    env
  );

  assert(split.code === 0, `split --cmd exits 0 (${split.stderr || "ok"})`);

  let newRuntimeId: string | undefined;
  for (let attempt = 0; attempt < 40 && !newRuntimeId; attempt++) {
    const summary = await client.call("app.summary", undefined);
    const newTerminal = summary.panes.find(
      (pane) => pane.kind === "terminal" && pane.runtimeId && !existingRuntimeIds.has(pane.runtimeId)
    );
    newRuntimeId = newTerminal?.runtimeId;
    if (!newRuntimeId) {
      await sleep(250);
    }
  }

  assert(!!newRuntimeId, "split --cmd creates a new terminal runtime");
  if (!newRuntimeId) {
    return;
  }

  let sawSummaryOutput = false;
  for (let attempt = 0; attempt < 40 && !sawSummaryOutput; attempt++) {
    const history = await callJsonRpc(ptyd, "terminal.history", {
      runtimeId: newRuntimeId,
      maxBytes: 16384
    });
    const output = (history as { data?: string }).data ?? "";
    sawSummaryOutput = output.includes("activePaneId");
    if (!sawSummaryOutput) {
      await sleep(250);
    }
  }

  assert(sawSummaryOutput, "split --cmd runs after hooks and can execute flmux summary");

  console.log("\nTerminal split command checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

