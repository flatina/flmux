import { describe, expect, it } from "bun:test";
import { resolveWorkspaceTabstripMode } from "../src/shared/runtimeMode";

describe("resolveWorkspaceTabstripMode", () => {
  it("web → outer-auto", () => {
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "web", platform: "win32" })).toBe("outer-auto");
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "web", platform: "darwin" })).toBe("outer-auto");
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "web", platform: "linux" })).toBe("outer-auto");
  });

  it("desktop windows → titlebar", () => {
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "desktop", platform: "win32" })).toBe("titlebar");
  });

  it("desktop mac/linux → outer-always (native titlebar)", () => {
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "desktop", platform: "darwin" })).toBe("outer-always");
    expect(resolveWorkspaceTabstripMode({ runtimeMode: "desktop", platform: "linux" })).toBe("outer-always");
  });
});
