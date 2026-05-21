import { describe, expect, it } from "bun:test";
import {
  createBrowserPaneSpec,
  type BrowserPaneCallable,
  type BrowserPaneController,
  type BrowserPaneStateRecord,
  type PaneSpec,
  type PaneWorkspaceContext
} from "@flmux/core/shell";

interface ControllerCall {
  paneId: string;
  op: BrowserPaneCallable;
  args: Record<string, unknown>;
}

function makeController(returnValue: unknown = null) {
  const calls: ControllerCall[] = [];
  const status: Record<string, unknown> = {};
  const controller: BrowserPaneController = {
    call: async (paneId, op, args) => {
      calls.push({ paneId, op, args });
      return { value: returnValue };
    },
    getStatus: () => (Object.keys(status).length ? status : undefined)
  };
  return { controller, calls, status };
}

function makeContext(
  spec: PaneSpec<BrowserPaneStateRecord>,
  override: Partial<{ paneId: string; record: BrowserPaneStateRecord }> = {}
) {
  const workspace: PaneWorkspaceContext = {
    id: "workspace.test",
    defaultBrowserPath: "https://example.test/",
    bus: {
      publish() {},
      subscribe() {
        return () => {};
      }
    },
    appOrigin: "https://example.test"
  };
  const subtree = spec.subtreeMounts?.[0];
  if (!subtree) throw new Error("spec missing subtreeMount[0]");
  const ctx = {
    paneId: override.paneId ?? "pane.browser",
    workspace,
    record: override.record ?? ({ kind: "browser" as const, url: "https://example.test/page" }),
    currentParams: undefined,
    setParams: async () => ({}),
    patchParams: async () => ({})
  };
  return { subtree, ctx };
}

describe("createBrowserPaneSpec", () => {
  it("declares callable ops via canCallStatePath", async () => {
    const { controller } = makeController();
    const spec = createBrowserPaneSpec({ controller });
    const { subtree, ctx } = makeContext(spec);
    const ops: BrowserPaneCallable[] = [
      "goBack",
      "reload",
      "evaluate",
      "click",
      "type",
      "press",
      "scroll",
      "screenshot",
      "capabilities"
    ];
    for (const op of ops) {
      expect(await subtree.canCallStatePath?.(ctx, [op])).toBe(true);
    }
    expect(await subtree.canCallStatePath?.(ctx, ["bogus"])).toBe(false);
    expect(await subtree.canCallStatePath?.(ctx, ["evaluate", "extra"])).toBe(false);
  });

  it("callState dispatches to controller with paneId + op + args", async () => {
    const { controller, calls } = makeController({ ok: true, value: 42 });
    const spec = createBrowserPaneSpec({ controller });
    const { subtree, ctx } = makeContext(spec, { paneId: "p123" });
    const result = await subtree.callState?.(ctx, ["evaluate"], { script: "1+1" });
    expect(result).toEqual({ value: { ok: true, value: 42 } });
    expect(calls).toEqual([{ paneId: "p123", op: "evaluate", args: { script: "1+1" } }]);
  });

  it("callState throws when no controller is wired", async () => {
    const spec = createBrowserPaneSpec();
    const { subtree, ctx } = makeContext(spec);
    await expect(subtree.callState?.(ctx, ["evaluate"], { script: "x" })).rejects.toThrow(/controller not wired/);
  });

  it("getStatusSnapshot merges record url with controller live fields", () => {
    const { controller, status } = makeController();
    status.title = "Live Title";
    status.loading = false;
    const spec = createBrowserPaneSpec({ controller });
    const { subtree, ctx } = makeContext(spec);
    expect(subtree.getStatusSnapshot?.(ctx)).toEqual({
      url: "https://example.test/page",
      title: "Live Title",
      loading: false
    });
  });

  it("getStatusSnapshot returns only url when controller has no live data", () => {
    const { controller } = makeController();
    const spec = createBrowserPaneSpec({ controller });
    const { subtree, ctx } = makeContext(spec);
    expect(subtree.getStatusSnapshot?.(ctx)).toEqual({ url: "https://example.test/page" });
  });

  it("preserves existing url set state path (regression)", async () => {
    const spec = createBrowserPaneSpec();
    const { subtree, ctx } = makeContext(spec);
    expect(await subtree.canSetStatePath?.(ctx, ["url"])).toBe(true);
    expect(await subtree.canSetStatePath?.(ctx, ["title"])).toBe(false);
  });
});
