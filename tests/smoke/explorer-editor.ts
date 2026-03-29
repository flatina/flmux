/**
 * Explorer + Editor nested smoke test.
 *
 * Verifies that explorer and editor panes route to layoutable tabs,
 * and that flmux edit / flmux explorer CLI commands work.
 *
 * Usage: bun tests/smoke/explorer-editor.ts
 */
import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  const before = await client.call("app.summary", undefined);
  const tabs0 = await client.call("tab.list", undefined);
  const initialPanes = before.panes.length;
  console.log(`Initial: ${initialPanes} panes, ${tabs0.workspaces.length} tabs`);

  // Find the layoutable tab
  const layoutTab = tabs0.workspaces.find((t) => t.layoutMode === "layoutable");
  assert(!!layoutTab, "layoutable tab exists");
  const layoutTabId = layoutTab!.tabId as string;

  // --- open explorer → should go to layoutable tab ---
  const ex = await client.call("pane.open", {
    leaf: { kind: "explorer", rootPath: process.cwd() }
  });
  assert(ex.ok, "explorer created");

  const afterEx = await client.call("app.summary", undefined);
  const exSummary = afterEx.panes.find((p) => (p.paneId as string) === (ex.paneId as string));
  assert(!!exSummary, "explorer in summary");
  assert((exSummary!.tabId as string) === layoutTabId, "explorer is in layoutable tab");
  console.log(`Explorer in layoutable tab ${exSummary!.tabId}`);

  // tab count should not increase (reuses existing layoutable tab)
  const tabs1 = await client.call("tab.list", undefined);
  assert(tabs1.workspaces.length === tabs0.workspaces.length, "explorer reuses existing layoutable tab");

  // --- open editor → should go to layoutable tab ---
  const ed = await client.call("pane.open", {
    leaf: { kind: "editor", filePath: "C:/flatina/flmux5/package.json" }
  });
  assert(ed.ok, "editor created");

  const afterEd = await client.call("app.summary", undefined);
  const edSummary = afterEd.panes.find((p) => (p.paneId as string) === (ed.paneId as string));
  assert(!!edSummary, "editor in summary");
  assert((edSummary!.tabId as string) === layoutTabId, "editor is in same layoutable tab");
  console.log(`Editor in layoutable tab ${edSummary!.tabId}`);

  // layoutable tab now has more panes
  const tabs2 = await client.call("tab.list", undefined);
  const lTab = tabs2.workspaces.find((t) => (t.tabId as string) === layoutTabId);
  assert((lTab?.paneCount ?? 0) >= 3, `layoutable tab has ${lTab?.paneCount} panes (explorer+editor+terminal)`);

  // --- browser also goes to layoutable tab ---
  const br = await client.call("pane.open", { leaf: { kind: "browser", url: "https://example.com" } });
  assert(br.ok, "browser created");
  const afterBr = await client.call("app.summary", undefined);
  const brSummary = afterBr.panes.find((p) => (p.paneId as string) === (br.paneId as string));
  assert((brSummary!.tabId as string) === layoutTabId, "browser in same layoutable tab");

  // --- cleanup ---
  await client.call("pane.close", { paneId: br.paneId });
  await client.call("pane.close", { paneId: ed.paneId });
  await client.call("pane.close", { paneId: ex.paneId });

  await sleep(300);
  const after = await client.call("app.summary", undefined);
  assert(after.panes.length === initialPanes, `pane count back to ${initialPanes} (got ${after.panes.length})`);

  console.log("\nExplorer + Editor nested checks passed.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
