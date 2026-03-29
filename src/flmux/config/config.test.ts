import { describe, expect, test } from "bun:test";
import { getDefaultConfig, mergeConfig } from "./config";

describe("getDefaultConfig", () => {
  test("restoreLayout defaults to false", () => {
    expect(getDefaultConfig(true).app.restoreLayout).toBe(false);
    expect(getDefaultConfig(false).app.restoreLayout).toBe(false);
  });
});

describe("mergeConfig", () => {
  test("overrides restoreLayout", () => {
    const defaults = getDefaultConfig(false);
    const result = mergeConfig(defaults, { app: { restoreLayout: true } });
    expect(result.app.restoreLayout).toBe(true);
  });

  test("falls back to defaults when parsed is empty", () => {
    const defaults = getDefaultConfig(true);
    const result = mergeConfig(defaults, {});
    expect(result.app.restoreLayout).toBe(false);
  });

  test("ignores non-boolean values", () => {
    const defaults = getDefaultConfig(true);
    const result = mergeConfig(defaults, { ptyd: { stopOnExit: "yes" }, app: { restoreLayout: 42 } } as never);
    expect(result.app.restoreLayout).toBe(false);
  });

  test("ignores non-object sections", () => {
    const defaults = getDefaultConfig(false);
    const result = mergeConfig(defaults, { ptyd: 42, app: "bad" } as never);
    expect(result.app.restoreLayout).toBe(false);
  });
});
