import { describe, expect, it } from "bun:test";
import { resolveFlmuxRuntimeMode } from "../src/main/runtimeMode";
import { getFlmuxRendererLifecyclePolicy } from "../src/shared/runtimeMode";

describe("flmux runtime mode", () => {
  it("defaults to desktop mode", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts"])).toBe("desktop");
  });

  it("switches to web mode with --web", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts", "--web"])).toBe("web");
  });

  it("keeps renderer recovery desktop-only", () => {
    expect(getFlmuxRendererLifecyclePolicy("desktop")).toEqual({
      restoreSession: true,
      restoreTerminals: true,
      persistSession: true
    });
    expect(getFlmuxRendererLifecyclePolicy("web")).toEqual({
      restoreSession: false,
      restoreTerminals: false,
      persistSession: false
    });
  });
});
