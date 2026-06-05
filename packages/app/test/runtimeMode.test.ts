import { describe, expect, it } from "bun:test";
import { resolveFlmuxDevMode, resolveFlmuxHiddenWindow, resolveFlmuxRuntimeMode } from "../src/main/runtimeMode";

describe("flmux runtime mode", () => {
  it("defaults to desktop mode", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts"])).toBe("desktop");
  });

  it("switches to web mode with --web", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts", "--web"])).toBe("web");
  });

  it("dev mode via --dev or FLMUX_DEV_MODE=1 only", () => {
    expect(resolveFlmuxDevMode(["--dev"], {})).toBe(true);
    expect(resolveFlmuxDevMode([], { FLMUX_DEV_MODE: "1" })).toBe(true);
    expect(resolveFlmuxDevMode([], { FLMUX_DEV_MODE: "true" })).toBe(false);
    expect(resolveFlmuxDevMode([], {})).toBe(false);
  });

  it("hidden window via FLMUX_HIDDEN_WINDOW=1", () => {
    expect(resolveFlmuxHiddenWindow({ FLMUX_HIDDEN_WINDOW: "1" })).toBe(true);
    expect(resolveFlmuxHiddenWindow({})).toBe(false);
  });
});
