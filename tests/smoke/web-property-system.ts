// Run this after browser-cdp-readiness and browser pane / flweb smokes when
// sequencing manually. It assumes CDP is already available (browser.cdpBaseUrl
// populated) and layers browser pane automation on top of the web UI property path.
import { subscribePropertyChanges } from "../../src/flmux/client/rpc-client";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { loadConfig } from "../../src/flmux/config/config";
import type { PropertyChangeEvent } from "../../src/types/property";
import { assert, runCli, sleep, waitForApp, waitForPropertyEvent } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const config = loadConfig();
  const webUiUrl = `http://${config.web.host}:${config.web.port}`;
  const session = await resolveSession();
  const identify = await client.call("system.identify", undefined);
  const events: PropertyChangeEvent[] = [];
  const stream = subscribePropertyChanges(identify.sessionId, (event) => {
    events.push(event);
  });

  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath
  };

  try {
    const webFetch = await fetch(webUiUrl);
    assert(webFetch.ok, "web UI server responds");
    await waitForAppProperty(client, "browser.cdpBaseUrl");

    const created = await client.call("pane.open", {
      leaf: {
        kind: "browser",
        url: webUiUrl
      }
    });

    const envWithPane = {
      ...env,
      FLMUX_BROWSER: String(created.paneId)
    };

    const waitLoad = runCli(["src/flweb/index.ts", "wait", "load"], envWithPane);
    assert(waitLoad.code === 0, `flweb wait load exits 0 (${waitLoad.stderr || "ok"})`);
    const clickInspector = runCli(["src/flweb/index.ts", "click", "[title='Open Property Inspector']"], envWithPane);
    assert(clickInspector.code === 0, `flweb click titlebar Properties exits 0 (${clickInspector.stderr || "ok"})`);

    const waitInspector = runCli(["src/flweb/index.ts", "wait", "--text", "Generic inspector"], envWithPane);
    assert(waitInspector.code === 0, `flweb wait inspector exits 0 (${waitInspector.stderr || "ok"})`);

    const nextTitle = `web-props-${Date.now()}`;
    const fillTitle = runCli(
      ["src/flweb/index.ts", "fill", "[data-ref='app-card'] [data-key='title'] input[type='text']", nextTitle],
      envWithPane
    );
    assert(fillTitle.code === 0, `flweb fill app title exits 0 (${fillTitle.stderr || "ok"})`);

    const waitTitle = runCli(
      ["src/flweb/index.ts", "wait", "--fn", `document.querySelector('.titlebar-title')?.textContent?.trim() === ${JSON.stringify(nextTitle)}`],
      envWithPane
    );
    assert(waitTitle.code === 0, `flweb wait title update exits 0 (${waitTitle.stderr || "ok"})`);

    const titleText = runCli(["src/flweb/index.ts", "get", "text", ".titlebar-title"], envWithPane);
    assert(titleText.code === 0, `flweb get title exits 0 (${titleText.stderr || "ok"})`);
    assert(titleText.stdout === nextTitle, `web renderer title updated via inspector (got ${titleText.stdout})`);

    const propertyEvent = await waitForPropertyEvent(
      events,
      (event) => event.scope === "app" && event.key === "title" && event.value === nextTitle
    );
    assert(propertyEvent.value === nextTitle, "web renderer property change reaches main stream");

    await client.call("pane.close", { paneId: created.paneId });
  } finally {
    stream.close();
  }

  console.log("\nWeb property system checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function waitForAppProperty(
  client: Awaited<ReturnType<typeof waitForApp>>,
  key: string,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.call("props.get", {
      scope: "app",
      key
    });
    if (result.found && result.value) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for app property ${key}`);
}
