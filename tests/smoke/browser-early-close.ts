import { assert, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  const before = await client.call("app.summary", undefined);
  const initialPaneCount = before.panes.length;

  const browser = await client.call("pane.open", {
    leaf: {
      kind: "browser",
      url: "about:blank"
    }
  });
  assert(browser.ok, "browser pane opens");

  await client.call("pane.close", { paneId: browser.paneId });
  await sleep(500);

  const after = await client.call("app.summary", undefined);
  assert(after.panes.length === initialPaneCount, `pane count returns to ${initialPaneCount}`);

  const terminal = await client.call("pane.open", { leaf: { kind: "terminal" } });
  assert(terminal.ok, "app remains responsive after early browser close");
  await client.call("pane.close", { paneId: terminal.paneId });

  console.log("\nBrowser early close checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
