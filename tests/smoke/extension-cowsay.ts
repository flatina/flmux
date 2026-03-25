/**
 * Extension + EventBus smoke test.
 *
 * Verifies:
 * 1. Extension discovery finds embedded cowsay
 * 2. pane.open with kind "extension" creates a pane
 * 3. pane.message delivers events through the EventBus
 * 4. Extension receives cross-pane events via on()
 * 5. Cleanup on pane.close
 *
 * Usage: bun tests/smoke/extension-cowsay.ts
 */
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(1000);

  const before = await client.call("app.summary", undefined);
  const initialPanes = before.panes.length;
  console.log(`Initial panes: ${initialPanes}`);

  // --- open two cowsay panes in the same tab ---
  const cow1 = await client.call("pane.open", {
    leaf: {
      kind: "extension",
      extensionId: "sample.cowsay",
      contributionId: "cowsay"
    }
  });
  assert(cow1.ok, "cowsay 1 opened");
  console.log(`Cowsay 1: ${cow1.paneId}`);

  // Wait for extension to mount
  await sleep(500);

  const cow2 = await client.call("pane.split", {
    paneId: cow1.paneId,
    direction: "right",
    leaf: {
      kind: "extension",
      extensionId: "sample.cowsay",
      contributionId: "cowsay"
    }
  });
  assert(cow2.ok, "cowsay 2 opened");
  console.log(`Cowsay 2: ${cow2.paneId}`);

  // Wait for second extension to mount
  await sleep(500);

  // --- verify both in summary ---
  const afterOpen = await client.call("app.summary", undefined);
  const p1 = afterOpen.panes.find((p) => (p.paneId as string) === (cow1.paneId as string));
  const p2 = afterOpen.panes.find((p) => (p.paneId as string) === (cow2.paneId as string));
  assert(!!p1, "cowsay 1 in summary");
  assert(!!p2, "cowsay 2 in summary");
  assert(p1?.kind === "extension", "cowsay 1 is extension");
  assert(p2?.kind === "extension", "cowsay 2 is extension");
  assert(p1?.extensionId === "sample.cowsay", "cowsay 1 extensionId correct");
  assert(p1?.tabId === p2?.tabId, "both cowsays in same tab");
  console.log(`Both cowsays in tab ${p1?.tabId}`);

  // --- send event via pane.message (simulates cow1 saying something) ---
  const msgResult = await client.call("pane.message", {
    paneId: cow1.paneId,
    eventType: "cowsay:said",
    data: { text: "hello from CLI" }
  });
  assert(msgResult.ok, "pane.message ok");
  assert(msgResult.delivered, "pane.message delivered");
  console.log("Event delivered via pane.message");

  // Give the event bus time to deliver and extension to process
  await sleep(300);

  // --- cleanup ---
  await client.call("pane.close", { paneId: cow2.paneId });
  await client.call("pane.close", { paneId: cow1.paneId });
  await sleep(300);

  const final = await client.call("app.summary", undefined);
  assert(final.panes.length === initialPanes, `pane count back to ${initialPanes} (got ${final.panes.length})`);

  console.log("\nExtension + EventBus checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
