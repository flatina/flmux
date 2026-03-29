/**
 * Browser automation CLI smoke test.
 *
 * Verifies:
 * 1. `flmux browser new` creates an automatable browser pane
 * 2. `flmux browser connect` validates it
 * 3. `flweb snapshot` returns refs
 * 4. `flweb click` can follow a link
 * 5. `flweb get url` reflects the navigation
 *
 * Usage: bun tests/smoke/browser-automation-cli.ts
 */
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const summary = await client.call("app.summary", undefined);
  const session = await resolveSession();
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath
  };

  const aboutUrl = `${summary.webServerUrl}/about`;
  const created = runCli(["src/flmux/cli/index.ts", "browser", "new", aboutUrl], env);
  assert(created.code === 0, `browser new exits 0 (${created.stderr || "ok"})`);
  assert(created.stdout.startsWith("browser."), `browser new returns pane id (${created.stdout})`);

  const envWithPane = {
    ...env,
    FLMUX_BROWSER: created.stdout
  };

  const connected = runCli(["src/flmux/cli/index.ts", "browser", "connect", "--json"], envWithPane);
  assert(connected.code === 0, `browser connect exits 0 (${connected.stderr || "ok"})`);
  const connectJson = JSON.parse(connected.stdout) as { ok: boolean; title?: string };
  assert(connectJson.ok, "browser connect ok");
  assert(connectJson.title === "flmux", `browser connect sees title flmux (got ${connectJson.title})`);

  const snapshot = runCli(["src/flweb/index.ts", "snapshot", "--compact"], envWithPane);
  assert(snapshot.code === 0, `flweb snapshot exits 0 (${snapshot.stderr || "ok"})`);
  assert(snapshot.stdout.includes("@e1"), "snapshot contains refs");

  const firstText = runCli(["src/flweb/index.ts", "get", "text", "@e1"], envWithPane);
  assert(firstText.code === 0, `flweb get text exits 0 (${firstText.stderr || "ok"})`);
  assert(firstText.stdout === "/health", `get text @e1 returns /health (got ${firstText.stdout})`);

  const clicked = runCli(["src/flweb/index.ts", "click", "@e1"], envWithPane);
  assert(clicked.code === 0, `flweb click exits 0 (${clicked.stderr || "ok"})`);

  const waited = runCli(["src/flweb/index.ts", "wait", "load"], envWithPane);
  assert(waited.code === 0, `flweb wait load exits 0 (${waited.stderr || "ok"})`);

  const waitedUrl = runCli(["src/flweb/index.ts", "wait", "--url", "**/health"], envWithPane);
  assert(waitedUrl.code === 0, `flweb wait --url exits 0 (${waitedUrl.stderr || "ok"})`);

  const currentUrl = runCli(["src/flweb/index.ts", "get", "url"], envWithPane);
  assert(currentUrl.code === 0, `flweb get url exits 0 (${currentUrl.stderr || "ok"})`);
  assert(currentUrl.stdout.endsWith("/health"), `click followed /health link (got ${currentUrl.stdout})`);

  const pageTitle = runCli(["src/flweb/index.ts", "eval", "window.location.pathname"], envWithPane);
  assert(pageTitle.code === 0, `flweb eval exits 0 (${pageTitle.stderr || "ok"})`);
  assert(pageTitle.stdout === "/health", `eval window.location.pathname returns /health (got ${pageTitle.stdout})`);

  const wentBack = runCli(["src/flweb/index.ts", "back"], envWithPane);
  assert(wentBack.code === 0, `flweb back exits 0 (${wentBack.stderr || "ok"})`);
  assert(wentBack.stdout.endsWith("/about"), `back returns to /about (got ${wentBack.stdout})`);

  const wentForward = runCli(["src/flweb/index.ts", "forward"], envWithPane);
  assert(wentForward.code === 0, `flweb forward exits 0 (${wentForward.stderr || "ok"})`);
  assert(wentForward.stdout.endsWith("/health"), `forward returns to /health (got ${wentForward.stdout})`);

  const reloaded = runCli(["src/flweb/index.ts", "reload"], envWithPane);
  assert(reloaded.code === 0, `flweb reload exits 0 (${reloaded.stderr || "ok"})`);
  assert(reloaded.stdout.endsWith("/health"), `reload stays on /health (got ${reloaded.stdout})`);

  const closed = runCli(["src/flmux/cli/index.ts", "browser", "close"], envWithPane);
  assert(closed.code === 0, `browser close exits 0 (${closed.stderr || "ok"})`);

  console.log("\nBrowser automation CLI checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

