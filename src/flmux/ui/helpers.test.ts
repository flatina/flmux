import { describe, expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-core";
import { asTabId } from "../../lib/ids";
import {
  browserTitleFromUrl,
  formatWorkspaceTitle,
  isBrowserPaneParams,
  isTerminalPaneParams,
  normalizeBrowserUrlValue,
  panelToSummary,
  sanitizeSerializedLayout,
  titleFromLeaf
} from "./helpers";

describe("sanitizeSerializedLayout", () => {
  test("sanitizes inner layout in layoutable tab", () => {
    const innerLayout = {
      grid: { root: { type: "branch", data: [] }, width: 400, height: 300, orientation: "HORIZONTAL" },
      panels: {
        "pane.b": { id: "pane.b", title: "Browser", contentComponent: "x", params: { kind: "browser", url: '{"url":"https://test.com"}', adapter: "electrobun-native" } }
      },
      activeGroup: "1"
    };
    const layout = {
      grid: { root: { type: "branch", data: [] }, width: 800, height: 600, orientation: "HORIZONTAL" },
      panels: {
        "tab.1": { id: "tab.1", title: "Workspace", contentComponent: "x", params: { tabKind: "tab", layoutMode: "layoutable", innerLayout, activePaneId: null } }
      },
      activeGroup: "1"
    } as unknown as SerializedDockview;

    const { changed, layout: result } = sanitizeSerializedLayout(layout);
    expect(changed).toBe(true);
    const inner = (result.panels as any)["tab.1"].params.innerLayout;
    expect((inner.panels as any)["pane.b"].params.url).toBe("https://test.com");
  });
});

describe("panelToSummary", () => {
  test("includes tabId", () => {
    const tabId = asTabId("tab.xyz");
    const summary = panelToSummary("pane.abc", tabId, "Terminal", { kind: "terminal", runtimeId: "rt.1" as any, cwd: null, shell: null, renderer: "xterm" });
    expect(summary.tabId as string).toBe("tab.xyz");
    expect(summary.paneId as string).toBe("pane.abc");
    expect(summary.kind).toBe("terminal");
  });
});

describe("isTerminalPaneParams / isBrowserPaneParams", () => {
  test("accepts valid terminal params", () => {
    expect(isTerminalPaneParams({ kind: "terminal", runtimeId: "rt.abc", renderer: "xterm" })).toBe(true);
  });

  test("rejects browser as terminal", () => {
    expect(isTerminalPaneParams({ kind: "browser", url: "x" })).toBe(false);
  });

  test("accepts valid browser params", () => {
    expect(isBrowserPaneParams({ kind: "browser", url: "https://x.com", adapter: "electrobun-native" })).toBe(true);
  });
});

describe("browserTitleFromUrl", () => {
  test("extracts hostname", () => {
    expect(browserTitleFromUrl("https://example.com/path")).toBe("example.com");
  });

  test("returns Browser for invalid url", () => {
    expect(browserTitleFromUrl("not-a-url")).toBe("Browser");
  });
});

describe("normalizeBrowserUrlValue", () => {
  test("extracts url from JSON string", () => {
    expect(normalizeBrowserUrlValue('{"url":"https://test.com"}')).toBe("https://test.com");
  });

  test("returns plain url as-is", () => {
    expect(normalizeBrowserUrlValue("https://test.com")).toBe("https://test.com");
  });
});

describe("titleFromLeaf", () => {
  test("uses explicit title", () => {
    expect(titleFromLeaf({ kind: "terminal", title: "My Shell" })).toBe("My Shell");
  });

  test("falls back to default", () => {
    expect(titleFromLeaf({ kind: "terminal" })).toBe("Terminal");
  });

  test("uses browser URL hostname", () => {
    expect(titleFromLeaf({ kind: "browser", url: "https://example.com" })).toBe("example.com");
  });
});

describe("formatWorkspaceTitle", () => {
  test("uses custom title when present", () => {
    expect(formatWorkspaceTitle(2, 3, "Project Alpha")).toBe("Project Alpha");
  });

  test("falls back to generated workspace title", () => {
    expect(formatWorkspaceTitle(2, 3)).toBe("Workspace2 (3 Tabs)");
  });
});
