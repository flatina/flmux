import { describe, expect, test } from "bun:test";
import { asPaneId, asTabId, asTerminalRuntimeId } from "../../lib/ids";
import type { PaneParams } from "../model/pane-params";
import type { PaneSummary } from "../model/workspace-types";
import type { PropertyChangeCallback } from "../props/property";
import { PaneScope, type PaneScopeHost } from "./pane-scope";
import { WorkspaceScope, type WorkspaceScopeHost } from "./workspace-scope";

type ChangeEvent = Parameters<PropertyChangeCallback>[0];

describe("property scopes", () => {
  test("WorkspaceScope get/set title", () => {
    const tabId = asTabId("tab.1");
    let title = "Workspace";
    let saves = 0;
    const renderer = {
      isLayoutable: true,
      getWorkspaceTitle: () => title,
      setWorkspaceTitle: (v: string) => { title = v; }
    } as any;
    const host: WorkspaceScopeHost = {
      queueSave() { saves++; },
      publishSimplePaneTitleChange() { throw new Error("not used"); }
    };

    const scope = new WorkspaceScope(host, tabId, renderer, () => {});

    expect(scope.get("title")).toBe("Workspace");
    scope.set("title", "Docs");
    expect(scope.get("title")).toBe("Docs");
    expect(title).toBe("Docs");
    expect(saves).toBe(1);
  });

  test("PaneScope browser/terminal properties", () => {
    const tabId = asTabId("tab.1");
    const paneId = asPaneId("browser.1");
    const runtimeId = asTerminalRuntimeId("rt.1");
    const paneSummaries = new Map<string, PaneSummary>([
      [String(paneId), { paneId, tabId, kind: "browser", title: "Browser", url: "about:blank", adapter: "electrobun-native" }],
      ["terminal.1", { paneId: asPaneId("terminal.1"), tabId, kind: "terminal", title: "Terminal", runtimeId, cwd: "C:/project", shell: "pwsh.exe", renderer: "xterm" }]
    ]);
    const updates: Array<{ paneId: string; patch: Record<string, unknown> }> = [];
    const renderer = {
      isLayoutable: true,
      getPaneTitle: (id: string) => paneSummaries.get(id)?.title ?? null,
      setPaneTitle: (id: string, v: string) => { const p = paneSummaries.get(id); if (p) p.title = v; }
    } as any;
    const createHost = (id: string): PaneScopeHost => ({
      queueSave() {},
      getPaneParams() { return paneSummaries.get(id) as PaneParams | null; },
      getTerminalRuntime(rid) {
        if (rid !== runtimeId) return null;
        return { runtimeId, cwd: "C:/project", shell: "pwsh.exe", startedAt: "2026-03-29T00:00:00.000Z", status: "running", exitCode: null, cols: 120, rows: 40 };
      },
      updatePaneParams(patch) {
        updates.push({ paneId: id, patch: patch as Record<string, unknown> });
        const p = paneSummaries.get(id);
        if (p && "url" in patch) p.url = patch.url as string;
      },
      publishSimpleWorkspaceTitleChange() {}
    });

    const browserPane = new PaneScope(createHost(String(paneId)), tabId, paneId, renderer, () => {});
    expect(browserPane.get("browser.url")).toBe("about:blank");
    browserPane.set("browser.url", "https://example.com");
    expect(updates).toEqual([{ paneId: String(paneId), patch: { url: "https://example.com" } }]);

    const terminalPane = new PaneScope(createHost("terminal.1"), tabId, asPaneId("terminal.1"), renderer, () => {});
    expect(terminalPane.get("terminal.cols")).toBe(120);
    expect(terminalPane.get("terminal.rows")).toBe(40);
  });

  test("title writes mirror workspace↔pane for simple tabs", () => {
    const tabId = asTabId("simple.1");
    const paneId = asPaneId("simple.1");
    const paneSummaries = new Map<string, PaneSummary>([
      [String(paneId), { paneId, tabId, kind: "browser", title: "Start", url: "about:blank", adapter: "electrobun-native" }]
    ]);
    const published: ChangeEvent[] = [];
    let title = "Start";
    let workspaceScope: WorkspaceScope | null = null;
    let paneScope: PaneScope | null = null;
    const renderer = {
      isLayoutable: false,
      getWorkspaceTitle: () => title,
      setWorkspaceTitle: (v: string) => { title = v; const p = paneSummaries.get(String(paneId)); if (p) p.title = v; },
      getPaneTitle: () => title,
      setPaneTitle: (_: string, v: string) => { title = v; const p = paneSummaries.get(String(paneId)); if (p) p.title = v; }
    } as any;
    const publish: PropertyChangeCallback = (e) => { published.push(e); };
    const host: WorkspaceScopeHost & PaneScopeHost = {
      queueSave() {},
      getPaneParams() { return paneSummaries.get(String(paneId)) as PaneParams | null; },
      getTerminalRuntime() { return null; },
      updatePaneParams() { throw new Error("not used"); },
      publishSimplePaneTitleChange(prev) { paneScope?.notify("title", prev); },
      publishSimpleWorkspaceTitleChange(prev) { workspaceScope?.notify("title", prev); }
    };

    workspaceScope = new WorkspaceScope(host, tabId, renderer, publish);
    paneScope = new PaneScope(host, tabId, paneId, renderer, publish);
    paneScope.set("title", "Docs");

    expect(published.map((e) => `${e.scope}.${e.key}`)).toEqual(["pane.title", "workspace.title"]);
    expect(published.map((e) => e.previousValue)).toEqual(["Start", "Start"]);
  });

  test("browser.url publish mirrored title changes", () => {
    const tabId = asTabId("simple.2");
    const paneId = asPaneId("simple.2");
    const paneSummaries = new Map<string, PaneSummary>([
      [String(paneId), { paneId, tabId, kind: "browser", title: "about:blank", url: "about:blank", adapter: "electrobun-native" }]
    ]);
    const published: ChangeEvent[] = [];
    let title = "about:blank";
    let workspaceScope: WorkspaceScope | null = null;
    let paneScope: PaneScope | null = null;
    const renderer = {
      isLayoutable: false,
      getWorkspaceTitle: () => title,
      setWorkspaceTitle: (v: string) => { title = v; },
      getPaneTitle: () => title,
      setPaneTitle: (_: string, v: string) => { title = v; const p = paneSummaries.get(String(paneId)); if (p) p.title = v; }
    } as any;
    const publish: PropertyChangeCallback = (e) => { published.push(e); };
    const host: WorkspaceScopeHost & PaneScopeHost = {
      queueSave() {},
      getPaneParams() { return paneSummaries.get(String(paneId)) as PaneParams | null; },
      getTerminalRuntime() { return null; },
      updatePaneParams(patch) { const p = paneSummaries.get(String(paneId)); if (p && "url" in patch) p.url = patch.url as string; },
      publishSimplePaneTitleChange(prev) { paneScope?.notify("title", prev); },
      publishSimpleWorkspaceTitleChange(prev) { workspaceScope?.notify("title", prev); }
    };

    workspaceScope = new WorkspaceScope(host, tabId, renderer, publish);
    paneScope = new PaneScope(host, tabId, paneId, renderer, publish);
    paneScope.set("browser.url", "https://example.com");

    expect(published.map((e) => `${e.scope}.${e.key}`)).toEqual(["pane.title", "workspace.title", "pane.browser.url"]);
    expect(published[1]?.previousValue).toBe("about:blank");
    expect(published[2]?.previousValue).toBe("about:blank");
  });

  test("PaneScope setState", () => {
    const tabId = asTabId("view.1");
    const paneId = asPaneId("view.1");
    const updates: Array<{ patch: Partial<PaneParams>; options?: { statePatch?: Record<string, unknown> } }> = [];
    const renderer = { isLayoutable: false, getPaneTitle: () => "View", setPaneTitle() {} } as any;
    const host: PaneScopeHost = {
      queueSave() {},
      getPaneParams() { return { kind: "view", viewKey: "sample.cowsay:cowsay", state: { open: true } }; },
      updatePaneParams(patch, options) { updates.push({ patch, options }); },
      getTerminalRuntime() { return null; },
      publishSimpleWorkspaceTitleChange() {}
    };

    new PaneScope(host, tabId, paneId, renderer, () => {}).setState({ open: true, count: 2 });
    expect(updates).toEqual([{ patch: {}, options: { statePatch: { open: true, count: 2 } } }]);
  });
});
