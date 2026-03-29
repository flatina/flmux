/**
 * Tab lifecycle smoke test.
 *
 * Verifies tab.list, tab.open, tab.focus, tab.close,
 * and PaneSummary.tabId field.
 *
 * Usage: bun tests/smoke/tab-lifecycle.ts
 */
import { assert, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  // --- baseline ---
  const tabs0 = await client.call("tab.list", undefined);
  const n = tabs0.workspaces.length;
  console.log(`Initial tabs: ${n}`);
  assert(n >= 1, "at least one tab exists");

  // verify default seed has a layoutable tab
  const layoutable = tabs0.workspaces.find((t) => t.layoutMode === "layoutable");
  assert(!!layoutable, "seed includes a layoutable tab");

  // --- tab.open ---
  const opened = await client.call("tab.open", { layoutMode: "layoutable" });
  assert(opened.ok, "tab.open ok");
  console.log(`Created tab: ${opened.tabId}`);

  const tabs1 = await client.call("tab.list", undefined);
  assert(tabs1.workspaces.length === n + 1, `tab count ${tabs1.workspaces.length} == ${n + 1}`);

  const created = tabs1.workspaces.find((t) => (t.tabId as string) === (opened.tabId as string));
  assert(!!created, "new tab in list");
  assert(created?.title?.startsWith("Workspace"), `tab title is Workspace* (got ${created?.title})`);
  assert(created?.layoutMode === "layoutable", "tab is layoutable");

  // --- tab.focus ---
  const focused = await client.call("tab.focus", { tabId: opened.tabId });
  assert(focused.ok, "tab.focus ok");

  // --- PaneSummary.tabId ---
  const summary = await client.call("app.summary", undefined);
  for (const pane of summary.panes) {
    assert(typeof pane.tabId === "string" && pane.tabId.length > 0, `pane ${pane.paneId} has tabId`);
  }
  console.log(`All ${summary.panes.length} panes have tabId`);

  // --- tab.close ---
  const closed = await client.call("tab.close", { tabId: opened.tabId });
  assert(closed.ok, "tab.close ok");

  const tabs2 = await client.call("tab.list", undefined);
  assert(tabs2.workspaces.length === n, `tab count back to ${n}`);

  console.log("\nTab lifecycle checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
