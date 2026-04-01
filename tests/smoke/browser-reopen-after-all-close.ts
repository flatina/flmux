import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();

  const summary = await client.call("app.summary", undefined);
  const session = await resolveSession();
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath
  };

  const firstUrl = `${summary.webServerUrl}/about?slot=1`;
  const reopenedUrl = `${summary.webServerUrl}/about?slot=2`;

  const first = openBrowser(firstUrl, env, "first");
  const firstClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], first.env);
  assert(firstClose.code === 0, `first browser close exits 0 (${firstClose.stderr || "ok"})`);
  await waitForPaneRemoved(client, first.paneId);

  const reopened = openBrowser(reopenedUrl, env, "reopened");
  const currentUrl = runCli(["src/flweb/index.ts", "get", "url"], reopened.env);
  assert(currentUrl.code === 0, `flweb get url after last-close reopen exits 0 (${currentUrl.stderr || "ok"})`);
  assert(currentUrl.stdout.endsWith("?slot=2"), `reopened browser stays on slot=2 (got ${currentUrl.stdout})`);

  const reopenedClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], reopened.env);
  assert(reopenedClose.code === 0, `reopened browser close exits 0 (${reopenedClose.stderr || "ok"})`);

  console.log("\nBrowser reopen-after-all-close checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function openBrowser(
  url: string,
  env: Record<string, string | undefined>,
  label: string
): { paneId: string; env: Record<string, string | undefined> } {
  const created = runCli(["src/flmux/cli/index.ts", "browser", "new", url], env);
  assert(created.code === 0, `${label} browser new exits 0 (${created.stderr || "ok"})`);
  assert(created.stdout.startsWith("browser."), `${label} browser new returns pane id (${created.stdout})`);

  const envWithPane = {
    ...env,
    FLMUX_BROWSER: created.stdout
  };

  const connected = runCli(["src/flmux/cli/index.ts", "browser", "connect", "--json"], envWithPane);
  assert(connected.code === 0, `${label} browser connect exits 0 (${connected.stderr || "ok"})`);

  return {
    paneId: created.stdout,
    env: envWithPane
  };
}

async function waitForPaneRemoved(client: Awaited<ReturnType<typeof waitForApp>>, paneId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const summary = await client.call("app.summary", undefined);
    const stillPresent = summary.panes.some((pane) => pane.paneId === paneId);
    if (!stillPresent) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for pane removal: ${paneId}`);
}
