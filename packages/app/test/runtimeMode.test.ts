import { describe, expect, it } from "bun:test";
import { resolveFlmuxRuntimeMode } from "../src/main/runtimeMode";

describe("flmux runtime mode", () => {
  it("defaults to desktop mode", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts"])).toBe("desktop");
  });

  it("switches to web mode with --web", () => {
    expect(resolveFlmuxRuntimeMode(["bun", "src/main.ts", "--web"])).toBe("web");
  });
});
