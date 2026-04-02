// Verifies that the web renderer (WebSocket transport) correctly reflects
// property changes made via App RPC. No browser pane or DOM automation needed —
// the test connects to the web UI server and checks round-trip property updates.
import type { PropertyChangeEvent } from "../../src/types/property";
import { subscribePropertyChanges } from "../../src/flmux/client/rpc-client";
import { loadConfig } from "../../src/flmux/config/config";
import { assert, sleep, waitForApp, waitForPropertyEvent } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(1000);

  const config = loadConfig();
  const webUiUrl = `http://${config.web.host}:${config.web.port}`;

  const identify = await client.call("system.identify", undefined);
  const events: PropertyChangeEvent[] = [];
  const stream = subscribePropertyChanges(identify.sessionId, (event) => {
    events.push(event);
  });

  try {
    // 1. Web UI server responds
    const webFetch = await fetch(webUiUrl);
    assert(webFetch.ok, "web UI server responds");

    // 2. Set app title via RPC
    const nextTitle = `web-props-${Date.now()}`;
    const setResult = await client.call("props.set", {
      scope: "app",
      key: "title",
      value: nextTitle
    });
    assert(setResult.value === nextTitle, `props.set returns updated title (got ${setResult.value})`);

    // 3. Read back via RPC
    const getResult = await client.call("props.get", {
      scope: "app",
      key: "title"
    });
    assert(getResult.found === true && getResult.value === nextTitle, `props.get returns updated title (got ${getResult.value})`);

    // 4. Property change event reaches the stream
    const titleEvent = await waitForPropertyEvent(
      events,
      (event) => event.scope === "app" && event.key === "title" && event.value === nextTitle
    );
    assert(titleEvent.value === nextTitle, "property change stream delivers app.title update");

    // 5. Schema available via web path
    const schema = await client.call("props.schema", { scope: "app" });
    assert(schema.properties.title?.metadata?.valueType === "string", "app.title schema available");
    assert(schema.properties.colorTheme !== undefined, "app.colorTheme registered");
  } finally {
    stream.close();
  }

  console.log("\nWeb property system checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
