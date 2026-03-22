import { describe, expect, test } from "bun:test";
import {
  asPaneId,
  asSessionId,
  asTabId,
  asTerminalRuntimeId,
  createPaneId,
  createSessionId,
  createTabId,
  createTerminalRuntimeId
} from "./ids";

describe("createPaneId", () => {
  test("default prefix is pane", () => {
    expect(createPaneId()).toMatch(/^pane\.[0-9a-f]{8}$/);
  });

  test("custom prefix", () => {
    expect(createPaneId("terminal")).toMatch(/^terminal\.[0-9a-f]{8}$/);
  });

  test("unique each call", () => {
    expect(createPaneId()).not.toBe(createPaneId());
  });
});

describe("createSessionId", () => {
  test("returns uuid format", () => {
    expect(createSessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("createTerminalRuntimeId", () => {
  test("has rt. prefix", () => {
    expect(createTerminalRuntimeId()).toMatch(/^rt\.[0-9a-f-]{12}$/);
  });
});

describe("createTabId", () => {
  test("default prefix is tab", () => {
    expect(createTabId()).toMatch(/^tab\.[0-9a-f]{8}$/);
  });

  test("custom prefix", () => {
    expect(createTabId("layout")).toMatch(/^layout\.[0-9a-f]{8}$/);
  });

  test("unique each call", () => {
    expect(createTabId()).not.toBe(createTabId());
  });
});

describe("as* cast functions", () => {
  test("asPaneId returns the same string", () => {
    expect(asPaneId("test") as string).toBe("test");
  });

  test("asSessionId returns the same string", () => {
    expect(asSessionId("test") as string).toBe("test");
  });

  test("asTerminalRuntimeId returns the same string", () => {
    expect(asTerminalRuntimeId("test") as string).toBe("test");
  });

  test("asTabId returns the same string", () => {
    expect(asTabId("test") as string).toBe("test");
  });
});
