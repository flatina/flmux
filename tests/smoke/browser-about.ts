/**
 * Browser about page smoke test.
 *
 * Opens the built-in about page in a browser pane and verifies:
 * 1. Web server content is fetchable
 * 2. Pane URL is correctly set via RPC
 *
 * Usage: bun tests/smoke/browser-about.ts
 */
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const summary = await client.call("app.summary", undefined);
  if (!summary.webServerUrl) {
    console.error("FAIL — webServerUrl not available");
    process.exitCode = 1;
    return;
  }

  const aboutUrl = `${summary.webServerUrl}/about`;

  // Verify about page is fetchable
  const aboutRes = await fetch(aboutUrl);
  const aboutHtml = await aboutRes.text();
  assert(aboutRes.ok && aboutHtml.includes("flmux"), "about page fetchable and contains flmux");

  // Open browser pane
  console.log(`Opening browser → ${aboutUrl}`);
  const pane = await client.call("pane.open", { leaf: { kind: "browser", url: aboutUrl } });

  // Poll until pane URL is set
  const deadline = Date.now() + 3000;
  let loaded = false;
  while (Date.now() < deadline) {
    const s = await client.call("app.summary", undefined);
    const p = s.panes.find((x) => x.paneId === pane.paneId);
    if (p?.url?.includes("/about")) {
      loaded = true;
      break;
    }
    await sleep(50);
  }
  assert(loaded, "browser pane URL confirmed via RPC");

  // Cleanup
  await client.call("pane.close", { paneId: pane.paneId });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
