import { describe, expect, test } from "bun:test";
import {
  createPaneParams,
  isBrowserPaneAdapter,
  isExplorerMode,
  isPaneKind,
  isPaneParams,
  isTerminalRenderer
} from "./pane-params";

describe("isPaneKind", () => {
  test("accepts valid kinds", () => {
    for (const kind of ["terminal", "browser", "editor", "explorer", "extension"]) {
      expect(isPaneKind(kind)).toBe(true);
    }
  });

  test("rejects invalid values", () => {
    expect(isPaneKind("unknown")).toBe(false);
    expect(isPaneKind(null)).toBe(false);
    expect(isPaneKind(42)).toBe(false);
  });
});

describe("isPaneParams", () => {
  test("accepts valid terminal params", () => {
    expect(isPaneParams({ kind: "terminal", runtimeId: "rt.abc", cwd: null, shell: null, renderer: "xterm" })).toBe(
      true
    );
  });

  test("accepts valid browser params", () => {
    expect(isPaneParams({ kind: "browser", url: "https://example.com", adapter: "electrobun-native" })).toBe(true);
  });

  test("rejects missing kind", () => {
    expect(isPaneParams({ url: "https://example.com" })).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isPaneParams(null)).toBe(false);
    expect(isPaneParams("terminal")).toBe(false);
    expect(isPaneParams(undefined)).toBe(false);
  });
});

describe("isTerminalRenderer", () => {
  test("accepts xterm and ghostty", () => {
    expect(isTerminalRenderer("xterm")).toBe(true);
    expect(isTerminalRenderer("ghostty")).toBe(true);
  });

  test("rejects others", () => {
    expect(isTerminalRenderer("vt100")).toBe(false);
  });
});

describe("isBrowserPaneAdapter", () => {
  test("accepts valid adapters", () => {
    expect(isBrowserPaneAdapter("electrobun-native")).toBe(true);
    expect(isBrowserPaneAdapter("web-iframe")).toBe(true);
  });
});

describe("isExplorerMode", () => {
  test("accepts valid modes", () => {
    expect(isExplorerMode("filetree")).toBe(true);
    expect(isExplorerMode("dirtree")).toBe(true);
    expect(isExplorerMode("filelist")).toBe(true);
  });
});

describe("createPaneParams", () => {
  test("creates terminal params with defaults", () => {
    const params = createPaneParams("terminal");
    expect(params.kind).toBe("terminal");
    expect(params.renderer).toBe("xterm");
    expect(params.runtimeId).toMatch(/^rt\./);
  });

  test("creates browser params with defaults", () => {
    const params = createPaneParams("browser");
    expect(params.kind).toBe("browser");
    expect(params.url).toBe("about:blank");
    expect(params.adapter).toBe("electrobun-native");
  });

  test("creates editor params with overrides", () => {
    const params = createPaneParams("editor", { filePath: "/tmp/test.ts", language: "typescript" });
    expect(params.kind).toBe("editor");
    expect(params.filePath).toBe("/tmp/test.ts");
    expect(params.language).toBe("typescript");
  });

  test("creates explorer params with defaults", () => {
    const params = createPaneParams("explorer");
    expect(params.kind).toBe("explorer");
    expect(params.mode).toBe("filetree");
    expect(params.watchEnabled).toBe(true);
  });
});
