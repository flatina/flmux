/**
 * Browser automation form smoke test.
 *
 * Verifies:
 * 1. `flweb fill` updates input values
 * 2. `flweb get value` reads them back
 * 3. `flweb get attr` reads stable attributes
 * 4. `flweb press Enter` triggers the submit behavior
 * 5. `flweb wait` can wait for a target to appear
 * 6. `flweb get text` reads the revealed result
 *
 * Usage: bun tests/smoke/browser-automation-form.ts
 */
import { resolve } from "node:path";
import { assert, sleep, waitForApp } from "./helpers";
import { resolveSession } from "../../src/cli/session-discovery";

const projectRoot = resolve(import.meta.dir, "../..");

function runCli(args: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd: projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    code: result.exitCode,
    stdout: Buffer.from(result.stdout).toString().trim(),
    stderr: Buffer.from(result.stderr).toString().trim()
  };
}

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const summary = await client.call("app.summary", undefined);
  const session = await resolveSession();
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath
  };

  const fixtureUrl = `${summary.webServerUrl}/automation`;
  const created = runCli(["src/cli/index.ts", "browser", "new", fixtureUrl], env);
  assert(created.code === 0, `browser new exits 0 (${created.stderr || "ok"})`);
  assert(created.stdout.startsWith("browser."), `browser new returns pane id (${created.stdout})`);

  const envWithPane = {
    ...env,
    FLMUX_BROWSER: created.stdout
  };

  const snapshot = runCli(["src/flweb/index.ts", "snapshot", "--compact"], envWithPane);
  assert(snapshot.code === 0, `flweb snapshot exits 0 (${snapshot.stderr || "ok"})`);
  assert(snapshot.stdout.includes("@e1"), "snapshot contains refs");

  const fillName = runCli(["src/flweb/index.ts", "fill", "@e3", "Jane"], envWithPane);
  assert(fillName.code === 0, `flweb fill name exits 0 (${fillName.stderr || "ok"})`);

  const fillEmail = runCli(["src/flweb/index.ts", "fill", "@e4", "jane@example.com"], envWithPane);
  assert(fillEmail.code === 0, `flweb fill email exits 0 (${fillEmail.stderr || "ok"})`);

  const nameValue = runCli(["src/flweb/index.ts", "get", "value", "@e3"], envWithPane);
  assert(nameValue.code === 0, `flweb get value name exits 0 (${nameValue.stderr || "ok"})`);
  assert(nameValue.stdout === "Jane", `name value is Jane (got ${nameValue.stdout})`);

  const emailPlaceholder = runCli(["src/flweb/index.ts", "get", "attr", "@e4", "placeholder"], envWithPane);
  assert(emailPlaceholder.code === 0, `flweb get attr exits 0 (${emailPlaceholder.stderr || "ok"})`);
  assert(
    emailPlaceholder.stdout === "name@example.com",
    `email placeholder is name@example.com (got ${emailPlaceholder.stdout})`
  );

  const focusName = runCli(["src/flweb/index.ts", "click", "@e2"], envWithPane);
  assert(focusName.code === 0, `flweb click focus button exits 0 (${focusName.stderr || "ok"})`);

  const fillNameAgain = runCli(["src/flweb/index.ts", "fill", "@e3", "Agent"], envWithPane);
  assert(fillNameAgain.code === 0, `flweb refill name exits 0 (${fillNameAgain.stderr || "ok"})`);

  const pressEnter = runCli(["src/flweb/index.ts", "press", "Enter"], envWithPane);
  assert(pressEnter.code === 0, `flweb press Enter exits 0 (${pressEnter.stderr || "ok"})`);

  const waitResult = runCli(["src/flweb/index.ts", "wait", "#result:not([hidden])"], envWithPane);
  assert(waitResult.code === 0, `flweb wait target exits 0 (${waitResult.stderr || "ok"})`);

  const resultText = runCli(["src/flweb/index.ts", "get", "text", "#result"], envWithPane);
  assert(resultText.code === 0, `flweb get text result exits 0 (${resultText.stderr || "ok"})`);
  assert(
    resultText.stdout === "submitted:Agent|jane@example.com",
    `result text matches submission (got ${resultText.stdout})`
  );

  const resultHtml = runCli(["src/flweb/index.ts", "get", "html", "#result"], envWithPane);
  assert(resultHtml.code === 0, `flweb get html exits 0 (${resultHtml.stderr || "ok"})`);
  assert(resultHtml.stdout === "submitted:Agent|jane@example.com", `result html matches text (got ${resultHtml.stdout})`);

  const statusEval = runCli(["src/flweb/index.ts", "eval", "document.querySelector('#status').textContent"], envWithPane);
  assert(statusEval.code === 0, `flweb eval exits 0 (${statusEval.stderr || "ok"})`);
  assert(
    statusEval.stdout.includes("Agent") && statusEval.stdout.includes("jane@example.com"),
    `eval reads status text (got ${statusEval.stdout})`
  );

  const reloaded = runCli(["src/flweb/index.ts", "reload"], envWithPane);
  assert(reloaded.code === 0, `flweb reload exits 0 (${reloaded.stderr || "ok"})`);
  assert(reloaded.stdout.endsWith("/automation"), `reload stays on fixture page (got ${reloaded.stdout})`);

  const closed = runCli(["src/cli/index.ts", "browser", "close"], envWithPane);
  assert(closed.code === 0, `browser close exits 0 (${closed.stderr || "ok"})`);

  console.log("\nBrowser automation form checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
