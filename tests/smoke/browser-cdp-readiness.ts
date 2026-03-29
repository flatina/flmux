/**
 * Smoke test: CDP readiness timing on startup.
 *
 * Validates that the app property `browser.cdpBaseUrl` becomes non-empty
 * within a reasonable window after app startup. This catches regressions in
 * the async CDP port probe that runs during main process initialization.
 *
 * Other browser/web-property smokes assume CDP is already available.
 * Running this test first surfaces timing issues independently.
 */
import { assert, sleep, waitForApp } from "./helpers";

const THRESHOLD_MS = 10_000;
const POLL_INTERVAL_MS = 100;

async function main() {
  const client = await waitForApp();

  // Mark the start right after the app is confirmed reachable.
  const start = Date.now();

  let elapsed = 0;
  let cdpBaseUrl: string | null = null;

  while (elapsed < THRESHOLD_MS) {
    const result = await client.call("props.get", {
      scope: "app",
      key: "browser.cdpBaseUrl"
    });
    const value = result.found ? result.value : null;
    if (typeof value === "string" && value.startsWith("http://127.0.0.1:")) {
      cdpBaseUrl = value;
      elapsed = Date.now() - start;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
    elapsed = Date.now() - start;
  }

  console.log(`  CDP readiness latency: ${elapsed}ms (threshold: ${THRESHOLD_MS}ms)`);

  assert(cdpBaseUrl !== null, `browser.cdpBaseUrl has expected prefix (got ${String(cdpBaseUrl)})`);
  assert(elapsed < THRESHOLD_MS, `CDP ready within ${THRESHOLD_MS}ms (actual: ${elapsed}ms)`);

  console.log("\nBrowser CDP readiness check passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
