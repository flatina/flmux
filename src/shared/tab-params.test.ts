import { describe, expect, test } from "bun:test";
import { isLayoutableTabParams, isTabParams } from "./tab-params";

describe("isTabParams", () => {
  test("accepts simple tab", () => {
    expect(isTabParams({ tabKind: "tab", layoutMode: "simple", paneKind: "browser" })).toBe(true);
  });

  test("accepts layoutable tab", () => {
    expect(
      isTabParams({ tabKind: "tab", layoutMode: "layoutable", innerLayout: null, activePaneId: null })
    ).toBe(true);
  });

  test("rejects pane params (no tabKind)", () => {
    expect(isTabParams({ kind: "terminal", runtimeId: "rt.abc" })).toBe(false);
  });

  test("rejects null and primitives", () => {
    expect(isTabParams(null)).toBe(false);
    expect(isTabParams("tab")).toBe(false);
    expect(isTabParams(undefined)).toBe(false);
  });
});

describe("isLayoutableTabParams", () => {
  test("accepts layoutable", () => {
    expect(
      isLayoutableTabParams({ tabKind: "tab", layoutMode: "layoutable", innerLayout: null, activePaneId: null })
    ).toBe(true);
  });

  test("rejects simple tab", () => {
    expect(isLayoutableTabParams({ tabKind: "tab", layoutMode: "simple", paneKind: "browser" })).toBe(false);
  });

  test("rejects non-tab", () => {
    expect(isLayoutableTabParams({ kind: "terminal" })).toBe(false);
  });
});
