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
  await waitForApp();
  await sleep(2000);

  const session = await resolveSession();
  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath
  };

  const result = runCli(
    [
      "src/cli/index.ts",
      "browser",
      "new",
      "https://example.com",
      "--placement",
      "right",
      "--source-pane",
      "terminal.DOES_NOT_EXIST"
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
