import { describe, expect, test } from "bun:test";
import { asPaneId, asTabId } from "../shared/ids";
import { EventBus } from "./event-bus";

const pane1 = asPaneId("pane.1");
const pane2 = asPaneId("pane.2");
const pane3 = asPaneId("pane.3");
const tab1 = asTabId("tab.1");
const tab2 = asTabId("tab.2");

describe("EventBus", () => {
  test("local scope: same tab receives events", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab1, "test:event", (e) => received.push(e.data));
    bus.emit(pane1, tab1, "test:event", "hello");
    expect(received).toEqual(["hello"]);
  });

  test("local scope: different tab does not receive events", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab2, "test:event", (e) => received.push(e.data));
    bus.emit(pane1, tab1, "test:event", "hello");
    expect(received).toEqual([]);
  });

  test("global scope: receives events from any tab", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab2, "test:event", (e) => received.push(e.data), { global: true });
    bus.emit(pane1, tab1, "test:event", "hello");
    expect(received).toEqual(["hello"]);
  });

  test("event type filtering", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab1, "test:a", (e) => received.push(e.data));
    bus.emit(pane1, tab1, "test:b", "wrong");
    bus.emit(pane1, tab1, "test:a", "right");
    expect(received).toEqual(["right"]);
  });

  test("unsubscribe via returned function", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    const unsub = bus.on(pane2, tab1, "test:event", (e) => received.push(e.data));
    bus.emit(pane1, tab1, "test:event", 1);
    unsub();
    bus.emit(pane1, tab1, "test:event", 2);
    expect(received).toEqual([1]);
  });

  test("disposePane removes all subscriptions for a pane", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab1, "test:a", (e) => received.push(e.data));
    bus.on(pane2, tab1, "test:b", (e) => received.push(e.data));
    bus.on(pane3, tab1, "test:a", (e) => received.push(e.data));
    bus.disposePane(pane2);
    bus.emit(pane1, tab1, "test:a", "after");
    bus.emit(pane1, tab1, "test:b", "after");
    expect(received).toEqual(["after"]); // only pane3 handler fires
  });

  test("error boundary: handler throw does not crash bus", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab1, "test:event", () => {
      throw new Error("bad handler");
    });
    bus.on(pane3, tab1, "test:event", (e) => received.push(e.data));
    bus.emit(pane1, tab1, "test:event", "ok");
    expect(received).toEqual(["ok"]);
  });

  test("event includes source, tabId, type, timestamp", () => {
    const bus = new EventBus();
    let captured: import("./event-bus").PaneEvent | null = null;
    bus.on(pane2, tab1, "test:event", (e) => {
      captured = e;
    });
    const before = Date.now();
    bus.emit(pane1, tab1, "test:event", { x: 42 });
    expect(captured).not.toBeNull();
    expect(captured!.source).toBe(pane1);
    expect(captured!.tabId).toBe(tab1);
    expect(captured!.type).toBe("test:event");
    expect(captured!.data).toEqual({ x: 42 });
    expect(captured!.timestamp).toBeGreaterThanOrEqual(before);
    expect(captured!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  test("dispose removes all subscriptions", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on(pane2, tab1, "test:event", (e) => received.push(e.data));
    bus.dispose();
    bus.emit(pane1, tab1, "test:event", "gone");
    expect(received).toEqual([]);
  });
});
