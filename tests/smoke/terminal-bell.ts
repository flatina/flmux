/**
 * Terminal bell smoke test.
 *
 * Sends BEL via ptyd to a non-active terminal,
 * verifies bell indicator appears in tab title and clears on focus.
 *
 * Usage: bun tests/smoke/terminal-bell.ts
 */
import { callJsonRpc } from "../../src/cli/rpc-client";
import { getPtydControlIpcPath } from "../../src/shared/ipc-paths";
import { resolveSession } from "../../src/cli/session-discovery";
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const session = await resolveSession();
  const ptyd = { ipcPath: getPtydControlIpcPath(session.sessionId) };

  const s0 = await client.call("app.summary", undefined);
  const t1 = s0.panes.find((p) => p.kind === "terminal");
  if (!t1) throw new Error("no terminal");

  // Split right to create t2
  const t2 = await client.call("pane.split", {
    paneId: t1.paneId,
    direction: "right",
    leaf: { kind: "terminal" }
  });
  assert(t2.ok, "t2 created");
  await sleep(1500);

  // Focus t1 so t2 is non-active
  await client.call("pane.focus", { paneId: t1.paneId });
  await sleep(300);

  // Send BEL to t2 via ptyd
  const s1 = await client.call("app.summary", undefined);
  const t2pane = s1.panes.find((p) => (p.paneId as string) === (t2.paneId as string));
  assert(!!t2pane?.runtimeId, "t2 has runtimeId");

  await callJsonRpc(ptyd, "terminal.input", {
    runtimeId: t2pane!.runtimeId,
    data: 'Write-Host "`a"\r'
  });
  await sleep(1500);

  // Check bell indicator in title
  const s2 = await client.call("app.summary", undefined);
  const t2after = s2.panes.find((p) => (p.paneId as string) === (t2.paneId as string));
  assert((t2after?.title ?? "").includes("\u{1F514}"), `bell in title (got: ${t2after?.title})`);

  // Focus t2 — bell should clear
  await client.call("pane.focus", { paneId: t2.paneId });
  await sleep(300);

  const s3 = await client.call("app.summary", undefined);
  const t2cleared = s3.panes.find((p) => (p.paneId as string) === (t2.paneId as string));
  assert(!(t2cleared?.title ?? "").includes("\u{1F514}"), "bell cleared on focus");

  // Cleanup
  await client.call("pane.close", { paneId: t2.paneId });

  console.log("\nTerminal bell checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
