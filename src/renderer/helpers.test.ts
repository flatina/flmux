import { describe, expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-core";
import { asTabId } from "../shared/ids";
import {
  browserTitleFromUrl,
  isBrowserPaneParams,
  isTerminalPaneParams,
  isV1Layout,
  migrateV1Layout,
  normalizeBrowserUrlValue,
  panelToSummary,
  sanitizeSerializedLayout,
  titleFromLeaf
} from "./helpers";

describe("isV1Layout / migrateV1Layout", () => {
  const v1Layout: SerializedDockview = {
    grid: { root: { type: "branch", data: [] }, width: 800, height: 600, orientation: "HORIZONTAL" },
    panels: {
      "pane.abc": { id: "pane.abc", title: "Terminal", contentComponent: "flmux-pane", params: { kind: "terminal", runtimeId: "rt.abc", cwd: null, shell: null, renderer: "xterm" } },
      "pane.def": { id: "pane.def", title: "Browser", contentComponent: "flmux-pane", params: { kind: "browser", url: "https://example.com", adapter: "electrobun-native" } }
    },
    activeGroup: "1"
  } as unknown as SerializedDockview;

  const v2Layout: SerializedDockview = {
    grid: { root: { type: "branch", data: [] }, width: 800, height: 600, orientation: "HORIZONTAL" },
    panels: {
      "tab.abc": { id: "tab.abc", title: "Workspace", contentComponent: "flmux-tab", params: { tabKind: "tab", layoutMode: "layoutable", innerLayout: null, activePaneId: null } }
    },
    activeGroup: "1"
  } as unknown as SerializedDockview;

  test("detects v1 layout", () => {
    expect(isV1Layout(v1Layout)).toBe(true);
  });

  test("detects v2 layout", () => {
    expect(isV1Layout(v2Layout)).toBe(false);
  });

  test("migrates v1 panels to simple tabs", () => {
    const migrated = migrateV1Layout(v1Layout);
    const termPanel = (migrated.panels as Record<string, any>)["pane.abc"];
    expect(termPanel.params.tabKind).toBe("tab");
    expect(termPanel.params.layoutMode).toBe("simple");
    expect(termPanel.params.paneKind).toBe("terminal");
    expect(termPanel.params.kind).toBe("terminal");
    expect(termPanel.params.runtimeId).toBe("rt.abc");
  });

  test("migration preserves browser params", () => {
    const migrated = migrateV1Layout(v1Layout);
    const browserPanel = (migrated.panels as Record<string, any>)["pane.def"];
    expect(browserPanel.params.tabKind).toBe("tab");
    expect(browserPanel.params.paneKind).toBe("browser");
    expect(browserPanel.params.url).toBe("https://example.com");
  });

  test("migration does not mutate original", () => {
    migrateV1Layout(v1Layout);
    const original = (v1Layout.panels as Record<string, any>)["pane.abc"];
    expect(original.params.tabKind).toBeUndefined();
  });
});

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
