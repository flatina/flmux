import { describe, expect, it } from "bun:test";
import { createTestBus, createTestPaneContext, createTestPaneStateStore, createTestShellClient } from "../src/testing";

describe("createTestBus", () => {
  it("delivers a publish to matching subscribers and stamps sourcePaneId", async () => {
    const bus = createTestBus("ws.1");
    const a = bus.attachPane("pane.a");
    const b = bus.attachPane("pane.b");
    const received: { topic: string; sourcePaneId: string }[] = [];
    b.subscribe("signal", (event) => received.push({ topic: event.topic, sourcePaneId: event.sourcePaneId }));

    const result = await a.publish("signal", { n: 1 });

    expect(result.ok).toBe(true);
    expect(result.value.published.workspaceId).toBe("ws.1");
    expect(received).toEqual([{ topic: "signal", sourcePaneId: "pane.a" }]);
  });

  it("matches '*' and 'prefix.*' patterns", async () => {
    const bus = createTestBus("ws.1");
    const a = bus.attachPane("a");
    const starTopics: string[] = [];
    const prefixTopics: string[] = [];
    a.subscribe("*", (event) => starTopics.push(event.topic));
    a.subscribe("plot.*", (event) => prefixTopics.push(event.topic));

    await a.publish("plot.selected");
    await a.publish("terminal.resized");

    expect(starTopics).toEqual(["plot.selected", "terminal.resized"]);
    expect(prefixTopics).toEqual(["plot.selected"]);
  });

  it("isolates subscriber exceptions", async () => {
    const bus = createTestBus("ws.1");
    const a = bus.attachPane("a");
    const order: string[] = [];
    a.subscribe("t", () => {
      order.push("first");
      throw new Error("boom");
    });
    a.subscribe("t", () => {
      order.push("second");
    });

    const result = await a.publish("t");
    expect(result.ok).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = createTestBus("ws.1");
    const a = bus.attachPane("a");
    let count = 0;
    const unsub = a.subscribe("t", () => {
      count++;
    });
    await a.publish("t");
    unsub();
    await a.publish("t");
    expect(count).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe("createTestPaneStateStore", () => {
  it("getParams returns a copy of initial state", () => {
    const store = createTestPaneStateStore({ params: { count: 5 } });
    const snapshot = store.getParams<{ count: number }>();
    expect(snapshot.count).toBe(5);
    snapshot.count = 99;
    expect(store.getParams<{ count: number }>().count).toBe(5);
  });

  it("setParams replaces, patchParams merges", () => {
    const store = createTestPaneStateStore({ params: { a: 1, b: 2 } });
    store.setParams({ c: 3 });
    expect(store.getParams()).toEqual({ c: 3 });
    store.patchParams({ d: 4 });
    expect(store.getParams()).toEqual({ c: 3, d: 4 });
  });

  it("title get/set", () => {
    const store = createTestPaneStateStore({ title: "Initial" });
    expect(store.getTitle()).toBe("Initial");
    store.setTitle("Updated");
    expect(store.getTitle()).toBe("Updated");
  });
});

describe("createTestShellClient", () => {
  it("routes get/list/set/call by op+path", async () => {
    const shell = createTestShellClient({
      "get /status/app/origin": () => "http://127.0.0.1:4000",
      "list /panes": () => [{ name: "pane.a", path: "/panes/pane.a", kind: "object", writable: false }],
      "set /workspaces/w/title": (_path, value) => value,
      "call /panes/new": (_path, args) => ({ paneId: `new-${(args as { kind: string }).kind}` })
    });

    const got = await shell.get("/status/app/origin");
    expect(got.ok && got.value).toBe("http://127.0.0.1:4000");

    const listed = await shell.list("/panes");
    expect(listed.ok && listed.entries).toHaveLength(1);

    const set = await shell.set("/workspaces/w/title", "New");
    expect(set.ok && set.value).toBe("New");

    const called = await shell.call("/panes/new", { kind: "cowsay" });
    expect(called.ok && (called.value as { paneId: string }).paneId).toBe("new-cowsay");
  });

  it("returns NOT_FOUND for unmapped routes", async () => {
    const shell = createTestShellClient();
    const got = await shell.get("/nope");
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe("NOT_FOUND");
  });
});

describe("createTestPaneContext", () => {
  it("defaults fill in bus/state/shell/ids", () => {
    const ctx = createTestPaneContext();
    expect(ctx.paneId).toBe("pane.test");
    expect(ctx.workspaceId).toBe("workspace.test");
    expect(typeof ctx.bus.publish).toBe("function");
    expect(typeof ctx.state.getParams).toBe("function");
    expect(typeof ctx.shell.get).toBe("function");
  });

  it("accepts a TestBus and attaches the pane automatically", async () => {
    const bus = createTestBus("ws.shared");
    const otherPane = bus.attachPane("pane.other");
    const received: string[] = [];
    otherPane.subscribe("t", (event) => received.push(event.sourcePaneId));

    const ctx = createTestPaneContext({ paneId: "pane.me", workspaceId: "ws.shared", bus });
    await ctx.bus.publish("t");

    expect(received).toEqual(["pane.me"]);
  });
});
