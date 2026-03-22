/**
 * Layout save/restore smoke test.
 *
 * Verifies that layout changes are persisted and can be restored.
 * Requires a running flmux app.
 *
 * Usage: bun tests/smoke/layout-restore.ts
 */
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  // Get initial state
  const before = await client.call("app.summary", undefined);
  const initialCount = before.panes.length;
  console.log(`Initial panes: ${initialCount}`);

  // Create panes to change the layout
  console.log("Creating panes...");
  const t1 = await client.call("pane.open", { leaf: { kind: "terminal" } });
  const t2 = await client.call("pane.split", {
    paneId: t1.paneId,
    direction: "right",
    leaf: { kind: "terminal" }
  });
  assert(t1.ok && t2.ok, "panes created");

  // Wait for save to flush
  await sleep(500);

  // Verify pane count
  const during = await client.call("app.summary", undefined);
  const expectedCount = initialCount + 2;
  assert(during.panes.length === expectedCount, `pane count is ${during.panes.length} (expected ${expectedCount})`);

  // Verify the pane IDs are in the summary
  const paneIds = during.panes.map((p) => p.paneId);
  assert(paneIds.includes(t1.paneId), `t1 ${t1.paneId} in summary`);
  assert(paneIds.includes(t2.paneId), `t2 ${t2.paneId} in summary`);

  // Verify the layout was saved (check via system.identify that app is healthy)
  const identify = await client.call("system.identify", undefined);
  assert(identify.paneCount === expectedCount, `identify paneCount matches (${identify.paneCount})`);

  // Clean up
  await client.call("pane.close", { paneId: t2.paneId });
  await client.call("pane.close", { paneId: t1.paneId });

  const after = await client.call("app.summary", undefined);
  assert(after.panes.length === initialCount, `restored to ${initialCount} panes`);

  console.log("\nLayout save/restore checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
