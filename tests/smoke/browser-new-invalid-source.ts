import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(2000);

  const session = await resolveSession();
  const summary = await client.call("app.summary", undefined);
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath,
    FLMUX_PANE_ID: "terminal.DOES_NOT_EXIST"
  };

  const result = runCli(
    [
      "src/flmux/cli/index.ts",
      "browser",
      "new",
      `${summary.webServerUrl}/health`,
      "--placement",
      "right"
    ],
    env
  );

  assert(result.code !== 0, `browser new with invalid source pane fails (${result.code})`);
  assert(
    result.stderr.includes("reference pane not found"),
    `invalid source pane reports reference error (${result.stderr || "missing stderr"})`
  );

  console.log("\nBrowser new invalid source checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

