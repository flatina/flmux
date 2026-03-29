/**
 * Nested split smoke test.
 *
 * Verifies that terminals route to layoutable tabs,
 * split operates within the inner Dockview,
 * and browser panes go to simple tabs.
 *
 * Usage: bun tests/smoke/nested-split.ts
 */
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  // --- baseline ---
  const before = await client.call("app.summary", undefined);
  const tabs0 = await client.call("tab.list", undefined);
  const initialPanes = before.panes.length;
  const initialTabs = tabs0.workspaces.length;
  console.log(`Initial: ${initialPanes} panes, ${initialTabs} tabs`);

  // --- open terminal → should go to layoutable tab ---
  const t1 = await client.call("pane.open", { leaf: { kind: "terminal" } });
  assert(t1.ok, "terminal t1 created");

  const afterT1 = await client.call("app.summary", undefined);
  const t1Summary = afterT1.panes.find((p) => (p.paneId as string) === (t1.paneId as string));
  assert(!!t1Summary, "t1 in summary");

  // t1 should be in a layoutable tab
  const tabsAfterT1 = await client.call("tab.list", undefined);
  const t1Tab = tabsAfterT1.workspaces.find((t) => (t.tabId as string) === (t1Summary?.tabId as string));
  assert(t1Tab?.layoutMode === "layoutable", `t1 is in layoutable tab (got ${t1Tab?.layoutMode})`);
  console.log(`Terminal t1 in tab ${t1Summary?.tabId}`);

  // --- split terminal → should stay in same layoutable tab ---
  const t2 = await client.call("pane.split", {
    paneId: t1.paneId,
    direction: "right",
    leaf: { kind: "terminal" }
  });
  assert(t2.ok, "split t2 created");

  const afterT2 = await client.call("app.summary", undefined);
  const t2Summary = afterT2.panes.find((p) => (p.paneId as string) === (t2.paneId as string));
  assert(!!t2Summary, "t2 in summary");
  assert(
    (t2Summary?.tabId as string) === (t1Summary?.tabId as string),
    "split terminal in same layoutable tab"
  );

  // tab count should not increase from split within layoutable
  const tabsAfterT2 = await client.call("tab.list", undefined);
  assert(tabsAfterT2.workspaces.length === tabsAfterT1.workspaces.length, "split within layoutable does not add tab");

  // the layoutable tab now has more panes
  const layoutTab = tabsAfterT2.workspaces.find((t) => (t.tabId as string) === (t1Summary?.tabId as string));
  assert((layoutTab?.paneCount ?? 0) >= 2, `layoutable tab has ${layoutTab?.paneCount} panes`);

  // --- open browser → should go to same layoutable tab ---
  const b1 = await client.call("pane.open", { leaf: { kind: "browser", url: "https://example.com" } });
  assert(b1.ok, "browser b1 created");

  const afterB1 = await client.call("app.summary", undefined);
  const b1Summary = afterB1.panes.find((p) => (p.paneId as string) === (b1.paneId as string));
  assert(!!b1Summary, "b1 in summary");

  // browser goes to the same layoutable tab
  assert(
    (b1Summary?.tabId as string) === (t1Summary?.tabId as string),
    "browser in same layoutable tab as terminals"
  );
  console.log(`Browser b1 in layoutable tab ${b1Summary?.tabId}`);

  // --- cleanup ---
  await client.call("pane.close", { paneId: b1.paneId });
  await client.call("pane.close", { paneId: t2.paneId });
  await client.call("pane.close", { paneId: t1.paneId });

  await sleep(300);
  const after = await client.call("app.summary", undefined);
  assert(after.panes.length === initialPanes, `pane count back to ${initialPanes} (got ${after.panes.length})`);

  console.log("\nNested split checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
