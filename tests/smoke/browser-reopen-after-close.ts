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

  const urls = [1, 2, 3, 4].map((index) => `${summary.webServerUrl}/about?slot=${index}`);

  const first = openBrowser(urls[0]!, env, "first");
  const second = openBrowser(urls[1]!, env, "second");
  const third = openBrowser(urls[2]!, env, "third");

  const secondClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], second.env);
  assert(secondClose.code === 0, `second browser close exits 0 (${secondClose.stderr || "ok"})`);
  await waitForPaneRemoved(client, second.paneId);

  const reopened = openBrowser(urls[3]!, env, "reopened");
  const reopenedUrl = runCli(["src/flweb/index.ts", "get", "url"], reopened.env);
  assert(reopenedUrl.code === 0, `flweb get url after reopen exits 0 (${reopenedUrl.stderr || "ok"})`);
  assert(reopenedUrl.stdout.endsWith("?slot=4"), `reopened browser stays on slot=4 (got ${reopenedUrl.stdout})`);

  const reopenedClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], reopened.env);
  assert(reopenedClose.code === 0, `reopened browser close exits 0 (${reopenedClose.stderr || "ok"})`);

  const thirdClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], third.env);
  assert(thirdClose.code === 0, `third browser close exits 0 (${thirdClose.stderr || "ok"})`);

  const firstClose = runCli(["src/flmux/cli/index.ts", "browser", "close"], first.env);
  assert(firstClose.code === 0, `first browser close exits 0 (${firstClose.stderr || "ok"})`);

  console.log("\nBrowser reopen-after-close checks passed.");
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
