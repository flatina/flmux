import { describe, expect, it } from "bun:test";
import { capturePaneInWorkspace } from "../src/renderer/external/paneCapture";
import { registerPaneForCapture, unregisterPaneForCapture } from "../src/renderer/external/paneCaptureRegistry";

// Guards run before any DOM work, so these need no DOM. The full
// resize→hook→rasterize→restore flow is verified e2e against a real pane.
const host = (id: string) => ({ id }) as unknown as HTMLElement;

describe("capturePaneInWorkspace guards", () => {
  it("rejects an unregistered target pane", async () => {
    await expect(capturePaneInWorkspace("ws1", "p.missing", { widthMm: 160 })).rejects.toThrow(/not a capturable/);
  });

  it("rejects a target pane in another workspace", async () => {
    const h = host("h.otherws");
    registerPaneForCapture("p.otherws", { host: h, workspaceId: "wsB", kind: "k" });
    await expect(capturePaneInWorkspace("wsA", "p.otherws", { widthMm: 160 })).rejects.toThrow(/another workspace/);
    unregisterPaneForCapture("p.otherws", h);
  });

  it("releases the exclusive lock after a guard rejection", async () => {
    await expect(capturePaneInWorkspace("ws1", "p.missing", { widthMm: 160 })).rejects.toThrow(/not a capturable/);
    // If the lock leaked, this would reject with "already in progress" instead.
    await expect(capturePaneInWorkspace("ws1", "p.missing", { widthMm: 160 })).rejects.toThrow(/not a capturable/);
  });
});
