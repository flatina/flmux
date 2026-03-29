import type { PropertyChangeEvent } from "../../src/types/property";
import { subscribePropertyChanges } from "../../src/flmux/client/rpc-client";
import { assert, sleep, waitForApp, waitForPropertyEvent } from "./helpers";

async function main() {
  const client = await waitForApp();
  await sleep(1000);

  const identify = await client.call("system.identify", undefined);
  const beforeSummary = await client.call("app.summary", undefined);
  const beforeTabs = await client.call("tab.list", undefined);
  const targetPaneId = beforeSummary.activePaneId ?? beforeSummary.panes[0]?.paneId ?? null;
  const targetTabId = beforeTabs.workspaces[0]?.tabId ?? null;
  if (!targetPaneId || !targetTabId) {
    throw new Error("No target pane/tab available for property smoke test");
  }

  const events: PropertyChangeEvent[] = [];
  const stream = subscribePropertyChanges(identify.sessionId, (event) => {
    events.push(event);
  });
  await sleep(100);

  try {
    const appTitle = `props-app-${Date.now()}`;
    const workspaceTitle = `props-workspace-${Date.now()}`;
    const paneTitle = `props-pane-${Date.now()}`;

    const appSet = await client.call("props.set", {
      scope: "app",
      key: "title",
      value: appTitle
    });
    assert(appSet.value === appTitle, "props.set updates app.title");
    const appSchema = await client.call("props.schema", { scope: "app" });
    assert(appSchema.properties.title?.metadata?.valueType === "string", "app.title metadata is exposed");

    const workspaceSet = await client.call("props.set", {
      scope: "workspace",
      targetId: targetTabId,
      key: "title",
      value: workspaceTitle
    });
    assert(workspaceSet.value === workspaceTitle, "props.set updates workspace.title");

    const paneSet = await client.call("props.set", {
      scope: "pane",
      targetId: targetPaneId,
      key: "title",
      value: paneTitle
    });
    assert(paneSet.value === paneTitle, "props.set updates pane.title");

    const titleEvent = await waitForPropertyEvent(
      events,
      (event) => event.scope === "pane" && event.key === "title"
    );
    assert(titleEvent.value === paneTitle, "property stream emits pane.title changes");

    const paneSchema = await client.call("props.schema", {
      scope: "pane",
      targetId: targetPaneId,
    });
    assert(paneSchema.properties.kind?.readonly === true, "readonly properties are marked readonly");

    const readonlyProperty = await client.call("props.get", {
      scope: "pane",
      targetId: targetPaneId,
      key: "kind"
    });
    assert(readonlyProperty.found === true, "props.get finds readonly property");

    let readonlyRejected = false;
    try {
      await client.call("props.set", {
        scope: "pane",
        targetId: targetPaneId,
        key: "kind",
        value: "browser"
      });
    } catch {
      readonlyRejected = true;
    }
    assert(readonlyRejected, "props.set rejects readonly properties");

    const appBrowserProperty = await client.call("props.get", {
      scope: "app",
      key: "browser.cdpBaseUrl"
    });
    assert(appBrowserProperty.found === true, "props.get returns app-scoped browser.cdpBaseUrl");

    const browserOpen = await client.call("pane.open", {
      leaf: {
        kind: "browser",
        url: "about:blank"
      }
    });
    await sleep(1200);

    const browserUrl = "https://example.com";
    const browserSet = await client.call("props.set", {
      scope: "pane",
      targetId: browserOpen.paneId,
      key: "browser.url",
      value: browserUrl
    });
    assert(browserSet.value === browserUrl, "props.set updates browser.url");
    const browserSchema = await client.call("props.schema", {
      scope: "pane",
      targetId: browserOpen.paneId
    });
    assert(browserSchema.properties["browser.url"]?.metadata?.valueType === "string", "browser.url metadata is exposed");

    const browserGet = await client.call("props.get", {
      scope: "pane",
      targetId: browserOpen.paneId,
      key: "browser.url"
    });
    assert(browserGet.found === true && browserGet.value === browserUrl, "props.get returns updated browser.url");

    const browserView = await client.call("props.get", {
      scope: "pane",
      targetId: browserOpen.paneId,
      key: "browser.webviewId"
    });
    assert(browserView.found === true, "props.get returns pane-scoped browser.webviewId value");
    assert(browserSchema.properties["browser.webviewId"]?.readonly === true, "browser.webviewId is readonly");
    assert(browserSchema.properties["browser.webviewId"]?.metadata?.valueType === "number", "browser.webviewId metadata is exposed");

    let unknownRejected = false;
    try {
      await client.call("props.set", {
        scope: "pane",
        targetId: browserOpen.paneId,
        key: "custom.note",
        value: "hello-property-system"
      });
    } catch {
      unknownRejected = true;
    }
    assert(unknownRejected, "props.set rejects unowned property keys");

    const browserEvent = await waitForPropertyEvent(
      events,
      (event) => String(event.targetId ?? "") === String(browserOpen.paneId) && event.key === "browser.url"
    );
    assert(browserEvent.value === browserUrl, "property stream emits browser.url changes");

    let readonlyBrowserRejected = false;
    try {
      await client.call("props.set", {
        scope: "pane",
        targetId: browserOpen.paneId,
        key: "browser.cdp.ready",
        value: true
      });
    } catch {
      readonlyBrowserRejected = true;
    }
    assert(readonlyBrowserRejected, "props.set rejects readonly browser properties");

    const inspectorOpen = await client.call("pane.open", {
      leaf: {
        kind: "view",
        viewKey: "property-inspector:inspector"
      }
    });
    await sleep(500);
    const afterInspector = await client.call("app.summary", undefined);
    const inspectorPane = afterInspector.panes.find((pane) => String(pane.paneId) === String(inspectorOpen.paneId));
    assert(inspectorPane?.viewKey === "property-inspector:inspector", "property inspector pane opens");
    assert(inspectorPane?.extensionId === "property-inspector", "property inspector extension id is exposed");

    await client.call("pane.close", { paneId: inspectorOpen.paneId });
    await client.call("pane.close", { paneId: browserOpen.paneId });
    const afterClose = await client.call("props.list", {
      scope: "pane",
      targetId: browserOpen.paneId
    });
    assert(Object.keys(afterClose.values).length === 0, "closed panes no longer expose properties");
  } finally {
    stream.close();
  }

  console.log("\nProperty system checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
