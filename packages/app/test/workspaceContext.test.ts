import { describe, expect, it } from "bun:test";
import { createWorkspaceBus } from "@flmux/core/shell";
import { buildPaneWorkspaceContext } from "../src/renderer/shell/workspaceContext";

describe("buildPaneWorkspaceContext", () => {
  // Pins 9896c66 fix: the bus supplied by the caller (the workspace record's
  // persistent bus) must reach the extension ctx by identity. Returning a
  // freshly-constructed bus here dropped every extension publish/subscribe.
  it("threads the caller's bus through by identity", () => {
    const bus = createWorkspaceBus("workspace.1");
    const ctx = buildPaneWorkspaceContext({
      workspaceId: "workspace.1",
      bus,
      appOrigin: "http://127.0.0.1:0"
    });
    expect(ctx.bus).toBe(bus);
  });

  it("publishes from ctx.bus reach subscribers on the same bus instance", () => {
    const bus = createWorkspaceBus("workspace.1");
    const ctx = buildPaneWorkspaceContext({
      workspaceId: "workspace.1",
      bus,
      appOrigin: "http://127.0.0.1:0"
    });
    const received: unknown[] = [];
    ctx.bus.subscribe("demo.*", (event) => received.push(event.payload));
    bus.publish({
      topic: "demo.ping",
      workspaceId: "workspace.1",
      sourcePaneId: "pane.a",
      payload: 42,
      timestamp: 0
    });
    expect(received).toEqual([42]);
  });

  it("encodes the workspace id into defaultBrowserPath", () => {
    const ctx = buildPaneWorkspaceContext({
      workspaceId: "workspace with space",
      bus: createWorkspaceBus("workspace with space"),
      appOrigin: "http://127.0.0.1:0"
    });
    expect(ctx.id).toBe("workspace with space");
    expect(ctx.defaultBrowserPath).toBe(
      "/__flmux/internal/start?workspace=workspace%20with%20space"
    );
  });
});
