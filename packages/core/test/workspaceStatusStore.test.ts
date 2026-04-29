import { describe, expect, it } from "bun:test";
import { createWorkspaceStatusStore } from "../src/shell/workspaceStatusStore";

describe("WorkspaceStatusStore", () => {
  it("stores and retrieves values per key", () => {
    const store = createWorkspaceStatusStore();
    store.set("selection", { id: 1 });
    expect(store.get<{ id: number }>("selection")).toEqual({ id: 1 });
    expect(store.get("missing")).toBeUndefined();
  });

  it("subscribe replays current value immediately, then emits on change", () => {
    const store = createWorkspaceStatusStore();
    store.set("cursor", "alpha");

    const received: unknown[] = [];
    const unsubscribe = store.subscribe("cursor", (value) => received.push(value));
    expect(received).toEqual(["alpha"]);

    store.set("cursor", "beta");
    expect(received).toEqual(["alpha", "beta"]);

    unsubscribe();
    store.set("cursor", "gamma");
    expect(received).toEqual(["alpha", "beta"]);
  });

  it("subscribe before any set replays undefined", () => {
    const store = createWorkspaceStatusStore();
    const received: unknown[] = [];
    store.subscribe("nothing", (value) => received.push(value));
    expect(received).toEqual([undefined]);
  });

  it("Object.is-equal sets do not re-emit", () => {
    const store = createWorkspaceStatusStore();
    const received: unknown[] = [];
    store.subscribe("x", (value) => received.push(value));

    store.set("x", 1);
    store.set("x", 1);
    const obj = { a: 1 };
    store.set("x", obj);
    store.set("x", obj);

    // initial undefined replay + 1 + obj = 3 entries (the second 1 and second obj are skipped)
    expect(received).toEqual([undefined, 1, obj]);
  });

  it("does not skip when value is structurally equal but not reference equal", () => {
    const store = createWorkspaceStatusStore();
    const received: unknown[] = [];
    store.subscribe("x", (value) => received.push(value));

    store.set("x", { a: 1 });
    store.set("x", { a: 1 });
    expect(received.length).toBe(3);
  });

  it("subscribers per key are isolated", () => {
    const store = createWorkspaceStatusStore();
    const a: unknown[] = [];
    const b: unknown[] = [];
    store.subscribe("a", (v) => a.push(v));
    store.subscribe("b", (v) => b.push(v));

    store.set("a", 1);
    store.set("b", 2);
    expect(a).toEqual([undefined, 1]);
    expect(b).toEqual([undefined, 2]);
  });

  it("subscriber exception does not affect other subscribers", () => {
    const store = createWorkspaceStatusStore();
    const received: unknown[] = [];
    store.subscribe("k", () => {
      throw new Error("boom");
    });
    store.subscribe("k", (v) => received.push(v));

    store.set("k", 42);
    expect(received).toEqual([undefined, 42]);
  });

  it("dispose clears subscribers and silences subsequent set", () => {
    const store = createWorkspaceStatusStore();
    const received: unknown[] = [];
    store.subscribe("k", (v) => received.push(v));
    store.dispose();

    store.set("k", "after-dispose");
    expect(received).toEqual([undefined]);
    expect(store.get("k")).toBeUndefined();
  });
});
