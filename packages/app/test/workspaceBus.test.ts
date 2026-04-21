import { describe, expect, it } from "bun:test";
import { createWorkspaceBus } from "@flmux/core/shell/workspaceBus";

describe("workspace bus", () => {
  it("continues dispatching when one subscriber throws", () => {
    const bus = createWorkspaceBus("workspace.test");
    const received: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      bus.subscribe("sample.*", () => {
        throw new Error("boom");
      });
      bus.subscribe("sample.*", (event) => {
        received.push(String(event.payload));
      });

      bus.publish({
        topic: "sample.updated",
        workspaceId: "workspace.test",
        sourcePaneId: "pane.test",
        payload: "ok",
        timestamp: Date.now()
      });

      expect(received).toEqual(["ok"]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
