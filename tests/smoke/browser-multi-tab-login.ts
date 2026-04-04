/**
 * Browser multi-tab login workflow smoke test.
 *
 * Simulates: main page -> login popup (target="_blank") -> fill + confirm -> popup closes -> main page logged in.
 * Verifies: new-tab detection, opener tracking, browser list, auto-targeting, cross-tab localStorage.
 */
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const summary = await client.call("app.summary", undefined);
  const session = await resolveSession();
  const env = { ...process.env, FLMUX_APP_IPC: session.ipcPath };

  // Step 1: Open main login page
  const mainUrl = `${summary.webServerUrl}/login-main`;
  const created = runCli(["src/flmux/cli/index.ts", "browser", "new", mainUrl], env);
  assert(created.code === 0, `browser new exits 0 (${created.stderr || "ok"})`);
  const mainPaneId = created.stdout;
  const envMain = { ...env, FLMUX_BROWSER: mainPaneId };

  const waitMain = runCli(["src/flweb/index.ts", "wait", "load"], envMain);
  assert(waitMain.code === 0, `main page loaded (${waitMain.stderr || "ok"})`);

  const initialStatus = runCli(["src/flweb/index.ts", "get", "text", "#login-status"], envMain);
  assert(initialStatus.stdout === "Not logged in", `initial status (got ${initialStatus.stdout})`);

  // Step 2: Click login button -> new tab with opener tracking
  const clickLogin = runCli(["src/flweb/index.ts", "click", "--json", "#login-btn"], envMain);
  assert(clickLogin.code === 0, `click login exits 0 (${clickLogin.stderr || "ok"})`);

  const clickResult = JSON.parse(clickLogin.stdout) as {
    ok: boolean;
    newPanes?: Array<{ paneId: string; url: string | null; openerPaneId: string | null }>;
  };
  assert(Array.isArray(clickResult.newPanes), `click result has newPanes array`);
  assert(clickResult.newPanes!.length === 1, `exactly 1 new pane opened (got ${clickResult.newPanes!.length})`);

  const popupPane = clickResult.newPanes![0]!;
  assert(popupPane.paneId.startsWith("browser."), `new pane id is browser-typed (${popupPane.paneId})`);
  assert(typeof popupPane.url === "string" && popupPane.url.includes("/login-popup"), `new pane url is login-popup (${popupPane.url})`);
  assert(popupPane.openerPaneId === mainPaneId, `opener is main pane (got ${popupPane.openerPaneId})`);

  const popupPaneId = popupPane.paneId;

  // Step 3: Verify browser list shows opener
  const listResult = runCli(["src/flmux/cli/index.ts", "browser", "list", "--json"], env);
  assert(listResult.code === 0, `browser list exits 0`);
  const listJson = JSON.parse(listResult.stdout) as {
    ok: boolean;
    panes: Array<{ paneId: string; isActive: boolean; openerPaneId: string | null }>;
  };
  const popupInList = listJson.panes.find((p) => p.paneId === popupPaneId);
  assert(!!popupInList, `popup in browser list`);
  assert(popupInList!.openerPaneId === mainPaneId, `list shows opener (got ${popupInList!.openerPaneId})`);

  // Step 4: Fill username and confirm in popup
  const envPopup = { ...env, FLMUX_BROWSER: popupPaneId };
  const waitPopup = runCli(["src/flweb/index.ts", "wait", "load"], envPopup);
  assert(waitPopup.code === 0, `popup loaded (${waitPopup.stderr || "ok"})`);

  const fillUser = runCli(["src/flweb/index.ts", "fill", "#username-input", "testuser"], envPopup);
  assert(fillUser.code === 0, `fill username exits 0`);

  const clickConfirm = runCli(["src/flweb/index.ts", "click", "#confirm-btn"], envPopup);
  assert(clickConfirm.code === 0, `click confirm exits 0`);

  // Step 5: Popup auto-closes via window.close() after confirm.
  // Wait for popup to disappear from browser list.
  await sleep(2000);

  // Step 6: Verify main page logged in
  const loggedIn = runCli(["src/flweb/index.ts", "get", "text", "#login-status"], envMain);
  assert(loggedIn.code === 0, `get logged-in status exits 0`);
  assert(loggedIn.stdout === "Logged in as: testuser", `main page logged in (got ${loggedIn.stdout})`);

  // Step 7: Popup gone from list
  const finalList = runCli(["src/flmux/cli/index.ts", "browser", "list", "--json"], env);
  const finalPanes = JSON.parse(finalList.stdout) as { panes: Array<{ paneId: string }> };
  assert(!finalPanes.panes.some((p) => p.paneId === popupPaneId), `popup removed from list`);

  // Cleanup
  runCli(["src/flmux/cli/index.ts", "browser", "close", "--pane", mainPaneId], env);

  console.log("\nBrowser multi-tab login workflow checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
