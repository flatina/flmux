/**
 * Login workflow test — simulates what a CLI agent would do using only flweb commands.
 *
 * Workflow: open app page → read page → click sign in → detect popup tab →
 * read popup → fill email + password → click sign in → verify main page logged in.
 *
 * Unlike smoke tests, this uses ONLY flweb CLI commands (no internal APIs).
 * The goal is to verify that an AI agent can complete a multi-step web workflow.
 */
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "../smoke/helpers";

/** Run a flweb command and return parsed output. */
function flweb(args: string[], env: Record<string, string | undefined>) {
  return runCli(["src/flweb/index.ts", ...args], env);
}

/** Run a flmux CLI command. */
function flmux(args: string[], env: Record<string, string | undefined>) {
  return runCli(["src/flmux/cli/index.ts", ...args], env);
}

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const summary = await client.call("app.summary", undefined);
  const session = await resolveSession();
  const env = { ...process.env, FLMUX_APP_IPC: session.ipcPath };

  // Step 1: Agent opens a browser tab to the app page
  const mainUrl = `${summary.webServerUrl}/login-main`;
  const browserNew = flmux(["browser", "new", mainUrl], env);
  assert(browserNew.code === 0, "open app page");
  const mainPaneId = browserNew.stdout;
  const mainEnv = { ...env, FLMUX_BROWSER: mainPaneId };

  // Wait for page to load
  const waitLoad = flweb(["wait", "load"], mainEnv);
  assert(waitLoad.code === 0, "wait for page load");

  // Step 2: Agent takes a snapshot to understand the page
  const snap = flweb(["snapshot"], mainEnv);
  assert(snap.code === 0, "snapshot page");
  assert(snap.stdout.includes("Sign In"), "snapshot shows sign in link");

  // Step 3: Agent sees guest state (Sign In button visible)
  const title = flweb(["get", "title"], mainEnv);
  assert(title.code === 0, "read title");
  assert(title.stdout === "My App", `title is 'My App' (got ${title.stdout})`);

  // Step 4: Agent clicks the sign in button (opens popup in new tab)
  const click = flweb(["click", "--json", "#login-btn"], mainEnv);
  assert(click.code === 0, "click sign in button");

  // Step 5: Agent detects the new tab from click output
  const clickResult = JSON.parse(click.stdout);
  assert(Array.isArray(clickResult.newPanes) && clickResult.newPanes.length === 1,
    `detected 1 new tab (got ${clickResult.newPanes?.length ?? 0})`);
  const popupPaneId = clickResult.newPanes[0].paneId;

  // Step 6: Agent switches to the popup tab
  const popupEnv = { ...env, FLMUX_BROWSER: popupPaneId };
  const waitPopup = flweb(["wait", "load"], popupEnv);
  assert(waitPopup.code === 0, "wait for popup load");

  // Step 7: Agent takes a snapshot of the popup to understand the login form
  const popupSnap = flweb(["snapshot"], popupEnv);
  assert(popupSnap.code === 0, "snapshot popup");
  assert(popupSnap.stdout.includes("Email") || popupSnap.stdout.includes("email"),
    "popup has email field");
  assert(popupSnap.stdout.includes("Password") || popupSnap.stdout.includes("password"),
    "popup has password field");
  assert(popupSnap.stdout.includes("Sign In"),
    "popup has sign in button");

  // Step 8: Agent fills in email and password
  const fillEmail = flweb(["fill", "#email-input", "agent@example.com"], popupEnv);
  assert(fillEmail.code === 0, "fill email");
  const fillPassword = flweb(["fill", "#password-input", "test1234"], popupEnv);
  assert(fillPassword.code === 0, "fill password");

  // Step 9: Agent clicks Sign In
  const signIn = flweb(["click", "#sign-in-btn"], popupEnv);
  assert(signIn.code === 0, "click sign in");

  // Step 10: Agent waits for popup to close, then checks main page
  await sleep(2000);

  // Step 11: Agent verifies the main page changed — title now includes user email
  const titleAfter = flweb(["get", "title"], mainEnv);
  assert(titleAfter.code === 0, "read title after login");
  assert(titleAfter.stdout.includes("agent@example.com"),
    `title includes user email (got ${titleAfter.stdout})`);

  // Step 12: Agent verifies dashboard is visible
  const dashText = flweb(["get", "text", "#dashboard"], mainEnv);
  assert(dashText.code === 0, "read dashboard");
  assert(dashText.stdout.includes("Dashboard"), `dashboard visible (got ${dashText.stdout})`);

  // Cleanup
  flmux(["browser", "close", "--pane", mainPaneId], env);

  console.log("\nLogin workflow test passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
