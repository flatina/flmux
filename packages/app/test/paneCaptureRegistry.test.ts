import { describe, expect, it } from "bun:test";
import {
  getPaneForCapture,
  registerPaneForCapture,
  unregisterPaneForCapture
} from "../src/renderer/external/paneCaptureRegistry";

// Registry is a module-level Map → use a unique paneId per test.
const host = (id: string) => ({ id }) as unknown as HTMLElement;

describe("paneCaptureRegistry", () => {
  it("registers and resolves an entry", () => {
    const h = host("a");
    registerPaneForCapture("p.reg", { host: h, workspaceId: "ws1", kind: "demo.plot" });
    const entry = getPaneForCapture("p.reg");
    expect(entry?.host).toBe(h);
    expect(entry?.workspaceId).toBe("ws1");
    expect(entry?.kind).toBe("demo.plot");
  });

  it("element-aware unregister: a stale host must not wipe a recycled paneId's new entry", () => {
    const oldHost = host("old");
    const newHost = host("new");
    registerPaneForCapture("p.recycle", { host: oldHost, workspaceId: "ws1", kind: "k" });
    // dockview recycles the paneId for a fresh pane:
    registerPaneForCapture("p.recycle", { host: newHost, workspaceId: "ws1", kind: "k" });
    // the old pane's late dispose unregisters with the OLD host → no-op:
    unregisterPaneForCapture("p.recycle", oldHost);
    expect(getPaneForCapture("p.recycle")?.host).toBe(newHost);
    // the live pane's dispose with the matching host removes it:
    unregisterPaneForCapture("p.recycle", newHost);
    expect(getPaneForCapture("p.recycle")).toBeUndefined();
  });
});
