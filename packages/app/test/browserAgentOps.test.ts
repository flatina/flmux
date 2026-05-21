import { describe, expect, it } from "bun:test";
import type { PaneBrowserCap } from "../src/shared/rendererBridge";
import { dispatchAgentOp } from "../src/main/browserAgentSurface/ops";
import { PaneState } from "../src/main/browserAgentSurface/paneState";
import type { AuthorityBrowserPaneController } from "../src/main/browserPaneController";

/** Minimal mock cap — each op returns a programmed value (or runs a callback
 * for side-effect inspection). Records every call for assertions. */
interface CapMock {
  cap: PaneBrowserCap;
  calls: Array<{ op: string; args: unknown }>;
  setNavigationState(next: { lastLoadEpoch: number; isLoading: boolean; currentUrl: string }): void;
  setEvaluate(handler: (script: string, frameId?: string) => unknown): void;
  setBoundingRect(handler: (selector: string) => { rect: { x: number; y: number; width: number; height: number }; visible: boolean } | null): void;
  setWaitForSelector(handler: (selector: string) => { ok: boolean }): void;
}

function createCapMock(): CapMock {
  const calls: Array<{ op: string; args: unknown }> = [];
  let navState = { lastLoadEpoch: 1, isLoading: false, currentUrl: "https://example.test/" };
  let evaluateHandler: ((script: string, frameId?: string) => unknown) | null = null;
  let rectHandler:
    | ((selector: string) => { rect: { x: number; y: number; width: number; height: number }; visible: boolean } | null)
    | null = null;
  let waitForSelectorHandler: ((selector: string) => { ok: boolean }) | null = null;

  const record = (op: string, args: unknown, ret: unknown = undefined) => {
    calls.push({ op, args });
    return ret;
  };

  const cap = {
    evaluate: async ({ script, frameId }: { script: string; frameId?: string }) => {
      calls.push({ op: "evaluate", args: { script, frameId } });
      const v = evaluateHandler ? evaluateHandler(script, frameId) : null;
      return { ok: true, value: v };
    },
    click: async (args: unknown) => void record("click", args),
    type: async (args: unknown) => void record("type", args),
    press: async (args: unknown) => void record("press", args),
    scroll: async (args: unknown) => void record("scroll", args),
    mouse: async (args: unknown) => void record("mouse", args),
    pressAction: async (args: unknown) => void record("pressAction", args),
    screenshot: async (args: unknown) => {
      record("screenshot", args);
      return { ok: false, code: "not_supported", message: "mock" };
    },
    capabilities: async () => ({
      evaluate: true,
      crossOriginEval: false,
      surfaceEvents: true,
      nativeInputTrusted: true,
      click: true,
      type: true,
      press: true,
      scroll: true,
      screenshot: false
    }),
    goBack: async (args: unknown) => void record("goBack", args),
    reload: async (args: unknown) => void record("reload", args),
    respondToDialog: async (args: unknown) => void record("respondToDialog", args),
    setDialogTimeout: async (args: unknown) => void record("setDialogTimeout", args),
    waitForSelector: async ({ selector }: { selector: string }) => {
      calls.push({ op: "waitForSelector", args: { selector } });
      return waitForSelectorHandler ? waitForSelectorHandler(selector) : { ok: true };
    },
    waitForFunction: async ({ expression }: { expression: string }) => {
      calls.push({ op: "waitForFunction", args: { expression } });
      return { ok: true };
    },
    getConsoleBuffer: async () => [],
    getNavigationState: async () => navState,
    accessibilitySnapshot: async () => ({ ok: false, code: "not_supported", message: "mock" }),
    getBoundingRect: async ({ selector }: { selector: string }) => {
      calls.push({ op: "getBoundingRect", args: { selector } });
      const r = rectHandler ? rectHandler(selector) : null;
      if (!r) return { ok: false, code: "not_found", message: "mock" };
      return { ok: true, rect: r.rect, visible: r.visible };
    },
    listFrames: async () => ({ ok: true, frames: [] }),
    setDownloadPolicy: async (args: unknown) => void record("setDownloadPolicy", args),
    waitForDownload: async () => ({ ok: false, code: "timeout", message: "mock" }),
    acceptPopup: async (args: unknown) => {
      record("acceptPopup", args);
      return { ok: true };
    },
    dismissPopup: async (args: unknown) => void record("dismissPopup", args),
    dialogs: () => emptyStream(),
    consoleEvents: () => emptyStream(),
    surfaceEvents: () => emptyStream(),
    downloadEvents: () => emptyStream()
  } as unknown as PaneBrowserCap;

  return {
    cap,
    calls,
    setNavigationState(next) {
      navState = next;
    },
    setEvaluate(handler) {
      evaluateHandler = handler;
    },
    setBoundingRect(handler) {
      rectHandler = handler;
    },
    setWaitForSelector(handler) {
      waitForSelectorHandler = handler;
    }
  };
}

function emptyStream(): AsyncIterable<never> & { cancel?: () => void } {
  return {
    cancel() {},
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<{ value: never; done: true }>((_resolve) => {
            // never resolves — tests don't depend on stream content
          })
      };
    }
  };
}

function createStubController(cap: PaneBrowserCap): AuthorityBrowserPaneController {
  return {
    setConnection() {},
    clearConnectionIf() {},
    onConnectionChanged() {
      return () => {};
    },
    primCap: async () => cap,
    setAgentSurface() {},
    call: async () => ({ value: null }),
    getStatus: () => undefined
  };
}

const PANE_ID = "p_test";

function newState(cap: PaneBrowserCap): PaneState {
  return new PaneState(PANE_ID, createStubController(cap), async () => null);
}

describe("BrowserAgentSurface ops", () => {
  it("snapshot returns refs + registers them in state", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    const fakeRefs = [
      {
        ref: "@e1",
        selector: "#btn",
        rect: { x: 10, y: 20, width: 100, height: 40 },
        signature: {
          role: "button",
          name: "Submit",
          textHash: "abc12345",
          domOrderKey: "0.1.2"
        }
      }
    ];
    m.setEvaluate((script) => (script.includes("INTERACTIVE") ? fakeRefs : null));

    const result = await dispatchAgentOp("snapshot", m.cap, PANE_ID, state, {});
    expect(result.value).toMatchObject({ refs: [{ ref: "@e1", role: "button", name: "Submit" }] });
    expect(state.refRegistry.get("@e1")).toBeDefined();
  });

  it("click @ref resolves selector → getBoundingRect → cap.click center", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    state.refRegistry.beginSnapshot();
    state.refRegistry.register([
      {
        ref: "@e1",
        snapshotEpoch: 1,
        selector: "#btn",
        rect: { x: 10, y: 20, width: 100, height: 40 },
        signature: {
          role: "button",
          name: "Submit",
          textHash: "abc12345",
          domOrderKey: "0.1.2"
        }
      }
    ]);
    m.setBoundingRect(() => ({ rect: { x: 10, y: 20, width: 100, height: 40 }, visible: true }));
    // signature revalidation eval — return same signature
    m.setEvaluate(() => ({
      role: "button",
      name: "Submit",
      textHash: "abc12345",
      domOrderKey: "0.1.2"
    }));

    await dispatchAgentOp("click", m.cap, PANE_ID, state, { target: "@e1" });

    const clickCall = m.calls.find((c) => c.op === "click");
    expect(clickCall).toBeDefined();
    expect(clickCall!.args).toMatchObject({ paneId: PANE_ID, x: 60, y: 40 });
  });

  it("click {x, y} bypasses target resolution (BC primitive shape)", async () => {
    const m = createCapMock();
    const state = newState(m.cap);

    await dispatchAgentOp("click", m.cap, PANE_ID, state, { x: 50, y: 75 });

    const clickCall = m.calls.find((c) => c.op === "click");
    expect(clickCall!.args).toMatchObject({ x: 50, y: 75 });
    // No selector resolution attempt — no getBoundingRect / evaluate.
    expect(m.calls.find((c) => c.op === "getBoundingRect")).toBeUndefined();
  });

  it("stale_ref on signature mismatch", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    state.refRegistry.beginSnapshot();
    state.refRegistry.register([
      {
        ref: "@e1",
        snapshotEpoch: 1,
        selector: "#btn",
        rect: { x: 10, y: 20, width: 100, height: 40 },
        signature: {
          role: "button",
          name: "Submit",
          textHash: "abc12345",
          domOrderKey: "0.1.2"
        }
      }
    ]);
    m.setBoundingRect(() => ({ rect: { x: 10, y: 20, width: 100, height: 40 }, visible: true }));
    // Different element now at the same selector — role mismatch.
    m.setEvaluate(() => ({
      role: "link",
      name: "Submit",
      textHash: "abc12345",
      domOrderKey: "0.1.2"
    }));

    await expect(dispatchAgentOp("click", m.cap, PANE_ID, state, { target: "@e1" })).rejects.toThrow(/stale_ref/);
  });

  it("get text reads via evaluate against selector", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    m.setEvaluate((script) => {
      if (script.includes("innerText")) return "Hello world";
      return null;
    });

    const result = await dispatchAgentOp("getText", m.cap, PANE_ID, state, { target: "#hdr" });
    expect(result.value).toBe("Hello world");
  });

  it("wait url pre-resolves when already on target URL", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    m.setNavigationState({ lastLoadEpoch: 5, isLoading: false, currentUrl: "https://example.test/done" });

    const result = await dispatchAgentOp("wait", m.cap, PANE_ID, state, {
      variant: "url",
      arg: "**/done",
      timeoutMs: 100
    });
    expect(result.value).toMatchObject({ matched: true, url: "https://example.test/done" });
  });

  it("wait selector forwards to bunite waitForSelector", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    m.setWaitForSelector(() => ({ ok: true }));

    const result = await dispatchAgentOp("wait", m.cap, PANE_ID, state, {
      variant: "selector",
      arg: "#ready"
    });
    expect(result.value).toMatchObject({ matched: "#ready" });
    expect(m.calls.some((c) => c.op === "waitForSelector")).toBe(true);
  });

  it("dialog accept fails when no pending dialog", async () => {
    const m = createCapMock();
    const state = newState(m.cap);

    await expect(dispatchAgentOp("dialogAccept", m.cap, PANE_ID, state, {})).rejects.toThrow(/no pending dialog/);
  });

  it("dialog accept responds when pending dialog set", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    state.pendingDialog = { requestId: 7, kind: "confirm", message: "OK?" };

    const result = await dispatchAgentOp("dialogAccept", m.cap, PANE_ID, state, {});
    expect(result.value).toMatchObject({ kind: "confirm" });
    expect(state.pendingDialog).toBeNull();
    const respondCall = m.calls.find((c) => c.op === "respondToDialog");
    expect(respondCall!.args).toMatchObject({ requestId: 7, accept: true });
  });

  it("fill clears (ctrl+a + delete) and types when text non-empty", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    state.refRegistry.beginSnapshot();
    state.refRegistry.register([
      {
        ref: "@e1",
        snapshotEpoch: 1,
        selector: "#email",
        rect: { x: 0, y: 0, width: 200, height: 30 },
        signature: { role: "textbox", name: "Email", textHash: "abc", domOrderKey: "0.0" }
      }
    ]);
    m.setBoundingRect(() => ({ rect: { x: 0, y: 0, width: 200, height: 30 }, visible: true }));
    m.setEvaluate(() => ({ role: "textbox", name: "Email", textHash: "abc", domOrderKey: "0.0" }));

    await dispatchAgentOp("fill", m.cap, PANE_ID, state, { target: "@e1", text: "user@x" });

    const ops = m.calls.map((c) => c.op);
    expect(ops).toContain("click");
    expect(ops).toContain("press"); // ctrl+a + Delete
    expect(ops).toContain("type");
  });

  it("rejects frame-targeted click — bunite v10 input no-frame", async () => {
    const m = createCapMock();
    const state = newState(m.cap);
    state.refRegistry.beginSnapshot();
    state.refRegistry.register([
      {
        ref: "@e1",
        snapshotEpoch: 1,
        selector: "#in-frame",
        frameId: "frame-42",
        rect: { x: 0, y: 0, width: 50, height: 20 },
        signature: { role: "button", name: "X", textHash: "h", domOrderKey: "0" }
      }
    ]);
    m.setBoundingRect(() => ({ rect: { x: 0, y: 0, width: 50, height: 20 }, visible: true }));
    m.setEvaluate(() => ({ role: "button", name: "X", textHash: "h", domOrderKey: "0" }));

    await expect(dispatchAgentOp("click", m.cap, PANE_ID, state, { target: "@e1" })).rejects.toThrow(/frame-targeted/);
  });
});
