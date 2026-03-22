/**
 * Panel lifecycle smoke test.
 * Usage: bun tests/smoke/panel-lifecycle.ts
 */
import { assert, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const before = await client.call("app.summary", undefined);
  const n = before.panes.length;
  console.log(`Initial panes: ${n}`);

  const terminal = await client.call("pane.open", { leaf: { kind: "terminal" } });
  assert(terminal.ok, "terminal created");

  const browser = await client.call("pane.open", {
    leaf: { kind: "browser", url: before.webServerUrl ?? "https://example.com" }
  });
  assert(browser.ok, "browser created");

  const during = await client.call("app.summary", undefined);
  assert(during.panes.length === n + 2, `pane count ${during.panes.length} == ${n + 2}`);

  const split = await client.call("pane.split", {
    paneId: terminal.paneId,
    direction: "right",
    leaf: { kind: "terminal" }
  });
  assert(split.ok, "split created");

  await client.call("pane.close", { paneId: split.paneId });
  await client.call("pane.close", { paneId: browser.paneId });
  await client.call("pane.close", { paneId: terminal.paneId });

  const after = await client.call("app.summary", undefined);
  assert(after.panes.length === n, `pane count back to ${n} (got ${after.panes.length})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
