import { describe, expect, test } from "bun:test";
import { getDefaultConfig, mergeConfig } from "./config";

describe("getDefaultConfig", () => {
  test("restoreLayout defaults to false", () => {
    expect(getDefaultConfig(true).app.restoreLayout).toBe(false);
    expect(getDefaultConfig(false).app.restoreLayout).toBe(false);
  });

  test("dev mode defaults ptyd.stopOnExit to true", () => {
    expect(getDefaultConfig(true).ptyd.stopOnExit).toBe(true);
  });

  test("production mode defaults ptyd.stopOnExit to false", () => {
    expect(getDefaultConfig(false).ptyd.stopOnExit).toBe(false);
  });
});

describe("mergeConfig", () => {
  test("overrides restoreLayout", () => {
    const defaults = getDefaultConfig(false);
    const result = mergeConfig(defaults, { app: { restoreLayout: true } });
    expect(result.app.restoreLayout).toBe(true);
  });

  test("uses parsed ptyd value when present", () => {
    const defaults = getDefaultConfig(false);
    const result = mergeConfig(defaults, { ptyd: { stopOnExit: true } });
    expect(result.ptyd.stopOnExit).toBe(true);
  });

  test("falls back to defaults when parsed is empty", () => {
    const defaults = getDefaultConfig(true);
    const result = mergeConfig(defaults, {});
    expect(result.ptyd.stopOnExit).toBe(true);
    expect(result.app.restoreLayout).toBe(false);
  });

  test("ignores non-boolean values", () => {
    const defaults = getDefaultConfig(true);
    const result = mergeConfig(defaults, { ptyd: { stopOnExit: "yes" }, app: { restoreLayout: 42 } } as never);
    expect(result.ptyd.stopOnExit).toBe(true);
    expect(result.app.restoreLayout).toBe(false);
  });

  test("ignores non-object sections", () => {
    const defaults = getDefaultConfig(false);
    const result = mergeConfig(defaults, { ptyd: 42, app: "bad" } as never);
    expect(result.ptyd.stopOnExit).toBe(false);
    expect(result.app.restoreLayout).toBe(false);
  });
});
