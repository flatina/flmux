/**
 * Test: does "Controller is NULL" happen for split vs within?
 * Creates two browser panes — first as split, second as split OR within.
 * Check artifacts/app.log for "Controller is NULL" errors.
 */
import { captureAppWindow, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(1000);

  const summary = await client.call("app.summary", undefined);
  const webUrl = summary.webServerUrl;
  if (!webUrl) throw new Error("no webServerUrl");

  const terminal = summary.panes.find((p) => p.kind === "terminal");
  if (!terminal) throw new Error("no terminal pane");

  // b1: split right
  const b1 = await client.call("pane.open", {
    leaf: { kind: "browser", url: `${webUrl}/about` },
    referencePaneId: terminal.paneId,
    direction: "right"
  });
  console.log(`  b1: ${b1.paneId}`);
  await sleep(3000);

  // b2: test both directions — change "within" to "below" to compare
  const direction = "within";
  const b2 = await client.call("pane.open", {
    leaf: { kind: "browser", url: `${webUrl}/about` },
    referencePaneId: b1.paneId,
    direction
  });
  console.log(`  b2 (${direction}): ${b2.paneId}`);
  await sleep(3000);

  captureAppWindow("bug1-within-browser");
  await client.call("pane.close", { paneId: b2.paneId });
  await client.call("pane.close", { paneId: b1.paneId });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
