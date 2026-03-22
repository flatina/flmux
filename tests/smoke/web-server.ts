/**
 * Web server smoke test.
 * Usage: bun tests/smoke/web-server.ts
 */
import { assert, waitForApp } from "./helpers";

async function main() {
  const client = await waitForApp();
  const summary = await client.call("app.summary", undefined);
  const base = summary.webServerUrl;

  assert(!!base, "webServerUrl is present");
  if (!base) return;

  console.log(`Web server at ${base}`);

  const about = await fetch(`${base}/about`);
  assert(about.ok && (await about.text()).includes("flmux"), "/about serves expected content");

  const health = await fetch(`${base}/health`);
  assert(((await health.json()) as { ok: boolean }).ok, "/health returns ok");

  const status = await fetch(`${base}/api/status`);
  assert(((await status.json()) as { app: string }).app === "flmux", "/api/status returns app=flmux");

  const notFound = await fetch(`${base}/nonexistent`);
  assert(notFound.status === 404, "unknown path returns 404");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
