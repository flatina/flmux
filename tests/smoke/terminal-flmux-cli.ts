/**
 * Terminal CLI availability smoke test.
 *
 * Verifies that `flmux` command is available inside flmux terminals.
 * Sends `flmux summary` via ptyd input and checks for JSON output.
 *
 * Usage: bun tests/smoke/terminal-flmux-cli.ts
 */
import { callJsonRpc } from "../../src/flmux/client/rpc-client";
import { getPtydControlIpcPath } from "../../src/lib/ipc/ipc-paths";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const session = await resolveSession();
  const ptyd = { ipcPath: getPtydControlIpcPath(session.sessionId) };

  // Wait for terminal + hooks to be ready
  await sleep(5000);

  const summary = await client.call("app.summary", undefined);
  const terminal = summary.panes.find((p) => p.kind === "terminal");
  if (!terminal?.runtimeId) throw new Error("no terminal with runtimeId");

  console.log(`Using terminal ${terminal.paneId} (runtime ${terminal.runtimeId})`);

  // Run flmux summary — outputs JSON with activePaneId
  await callJsonRpc(ptyd, "terminal.input", {
    runtimeId: terminal.runtimeId,
    data: "flmux summary\r"
  });
  await sleep(3000);

  const history = await callJsonRpc(ptyd, "terminal.history", {
    runtimeId: terminal.runtimeId,
    maxBytes: 16384
  });

  const output = (history as { data?: string }).data ?? "";
  const hasCli = output.includes("activePaneId");

  console.log(`CLI output detected: ${hasCli}`);
  assert(hasCli, "flmux summary produces JSON output — CLI is available in terminal");

  console.log("\nTerminal flmux CLI checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
