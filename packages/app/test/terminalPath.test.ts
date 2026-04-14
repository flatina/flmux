import { describe, expect, it } from "bun:test";
import { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "../src/shared/terminalPath";

describe("terminal path helpers", () => {
  it("normalizes windows roots and resolves relative cwd segments", () => {
    expect(normalizeTerminalRootDir("C:/workspace/project")).toBe("C:\\workspace\\project");
    expect(resolveTerminalCwdFromRoot("C:\\workspace\\project", ".\\foo\\..\\bar")).toBe("C:\\workspace\\project\\bar");
    expect(resolveTerminalCwdFromRoot("C:\\workspace\\project", "..\\outside")).toBe("C:\\workspace\\outside");
  });

  it("passes through absolute cwd values after normalization", () => {
    expect(resolveTerminalCwdFromRoot("C:\\workspace\\project", "D:/logs")).toBe("D:\\logs");
    expect(resolveTerminalCwdFromRoot("/workspace/project", "/tmp/out")).toBe("/tmp/out");
  });
});
