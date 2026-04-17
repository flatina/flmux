import { describe, expect, it } from "bun:test";
import { toTerminalRootKey } from "../src/main/terminal-service/rootKey";
import { TestShellModelHost } from "./support/testShellModelHost";
import { createSyntheticTerminalService } from "./support/syntheticTerminalService";

const WORKSPACE_ROOT_DIR = "C:\\workspace";
const WORKSPACE_ROOT_KEY = toTerminalRootKey(WORKSPACE_ROOT_DIR);

describe("shell model direct", () => {
  it("serves workspace status and pane listings without the smoke harness", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        { id: "pane.browser", kind: "browser", title: "Browser", url: "https://example.test" },
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: "term_live"
        }
      ]
    });
    const model = host.createModel();

    const workspaceStatus = await model.pathGet("/status/workspace");
    expect(workspaceStatus).toEqual({
      ok: true,
      found: true,
      value: {
        id: "workspace.test",
        title: "Workspace Test",
        activePaneId: "pane.term",
        paneCount: 2
      }
    });

    const paneList = await model.pathList("/panes");
    expect(paneList).toMatchObject({ ok: true, found: true });
    if (paneList.ok && paneList.found) {
      expect(paneList.entries.map((entry) => entry.name)).toEqual(["pane.browser", "pane.term"]);
      expect(paneList.entries.map((entry) => entry.name)).not.toContain("current");
    }

    const paneStatus = await model.pathGet("/status/panes/pane.term/terminal/runtimeId");
    expect(paneStatus).toEqual({
      ok: true,
      found: true,
      value: "term_live"
    });

    const paneState = await model.pathGet("/panes/pane.term");
    expect(paneState).toEqual({
      ok: true,
      found: true,
      value: {
        kind: "terminal",
        title: "Terminal",
        terminal: {
          cwd: WORKSPACE_ROOT_DIR
        }
      }
    });
  });

  it("creates and lists workspaces through /workspaces/new", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    expect(await model.pathList("/workspaces")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "workspace.test", path: "/workspaces/workspace.test", kind: "object", writable: false },
        { name: "new", path: "/workspaces/new", kind: "action", writable: false }
      ]
    });

    const created = await model.pathCall("/workspaces/new", { title: "Workspace Gamma" });
    if (!created.ok) {
      throw new Error("expected workspace creation to succeed");
    }

    const createdValue = JSON.parse(JSON.stringify(created.value)) as {
      workspaceId: string;
      path: string;
      workspace: {
        id: string;
        title: string;
        activePaneId: string | null;
        paneCount: number;
      };
    };

    expect(created).toMatchObject({
      ok: true,
      value: {
        workspaceId: expect.stringMatching(/^workspace\.\d+$/),
        path: expect.stringMatching(/^\/workspaces\/workspace\.\d+$/),
        workspace: {
          title: "Workspace Gamma",
          activePaneId: expect.any(String),
          paneCount: 2
        }
      }
    });
    expect(host.calls.createWorkspace).toEqual([{ title: "Workspace Gamma" }]);

    expect(await model.pathGet(createdValue.path)).toEqual({
      ok: true,
      found: true,
      value: createdValue.workspace
    });
    expect(await model.pathGet("/status/workspace")).toEqual({
      ok: true,
      found: true,
      value: createdValue.workspace
    });
    expect(await model.pathGet(`/workspaces/${createdValue.workspaceId}/title`)).toEqual({
      ok: true,
      found: true,
      value: "Workspace Gamma"
    });
    expect(await model.pathGet(`/workspaces/${createdValue.workspaceId}/paneCount`)).toEqual({
      ok: true,
      found: true,
      value: 2
    });

    const listed = await model.pathList("/workspaces");
    expect(listed).toMatchObject({ ok: true, found: true });
    if (listed.ok && listed.found) {
      expect(listed.entries.map((entry) => entry.name)).toContain(createdValue.workspaceId);
      expect(listed.entries.map((entry) => entry.name)).toContain("new");
    }
  });

  it("resets a workspace through /workspaces/{id}/reset", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    const browserPane = await model.pathCall("/panes/new", { kind: "browser", place: "right" });
    expect(browserPane.ok).toBe(true);

    const reset = await model.pathCall("/workspaces/workspace.test/reset");
    if (!reset.ok) {
      throw new Error("expected /workspaces/{id}/reset to succeed");
    }
    expect(reset.value).toMatchObject({
      workspaceId: "workspace.test",
      workspace: {
        id: "workspace.test",
        paneCount: 2
      }
    });

    const status = await model.pathGet("/status/workspace");
    expect(status).toMatchObject({ ok: true, found: true, value: { id: "workspace.test", paneCount: 2 } });
  });

  it("supports writable app, workspace, and browser subtree state paths", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.browser",
      panes: [
        { id: "pane.browser", kind: "browser", title: "Browser", url: "https://example.test" },
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: null
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathSet("/app/title", "Flmux Test")).toEqual({
      ok: true,
      value: "Flmux Test"
    });
    expect(await model.pathSet("/title", "Workspace Renamed")).toEqual({
      ok: true,
      value: "Workspace Renamed"
    });
    expect(await model.pathSet("/workspaces/workspace.test/title", "Workspace Explicit")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
    expect(await model.pathGet("/panes/pane.browser/browser")).toEqual({
      ok: true,
      found: true,
      value: {
        url: "https://example.test"
      }
    });
    expect(await model.pathList("/panes/pane.browser")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "kind", path: "/panes/pane.browser/kind", kind: "leaf", writable: false },
        { name: "title", path: "/panes/pane.browser/title", kind: "leaf", writable: true },
        { name: "close", path: "/panes/pane.browser/close", kind: "action", writable: false },
        { name: "browser", path: "/panes/pane.browser/browser", kind: "object", writable: false }
      ]
    });
    expect(await model.pathList("/panes/pane.browser/browser")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "url", path: "/panes/pane.browser/browser/url", kind: "leaf", writable: true }
      ]
    });
    expect(await model.pathList("/workspaces/workspace.test")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "id", path: "/workspaces/workspace.test/id", kind: "leaf", writable: false },
        { name: "title", path: "/workspaces/workspace.test/title", kind: "leaf", writable: false },
        { name: "activePaneId", path: "/workspaces/workspace.test/activePaneId", kind: "leaf", writable: false },
        { name: "paneCount", path: "/workspaces/workspace.test/paneCount", kind: "leaf", writable: false }
      ]
    });
    expect(await model.pathSet("/panes/pane.browser/browser/url", "https://example.next")).toEqual({
      ok: true,
      value: "https://example.next"
    });
    expect(await model.pathGet("/panes/pane.browser/url")).toEqual({
      ok: true,
      found: false,
      value: null
    });
    expect(await model.pathSet("/panes/pane.browser/url", "https://old-path.invalid")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
    expect(await model.pathSet("/panes/pane.term/browser/url", "https://should.fail")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });

    expect(host.calls.setScopedProperty).toEqual([
      { target: { scope: "app" }, key: "title", value: "Flmux Test" },
      { target: { scope: "workspace" }, key: "title", value: "Workspace Renamed" }
    ]);
    expect(host.calls.setPaneParams).toEqual([
      {
        paneId: "pane.browser",
        nextParams: {
          url: "https://example.next"
        }
      }
    ]);
    expect(await model.pathSet("/workspaces/workspace.missing/title", "Missing")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
    expect(await model.pathSet("/workspaces/new/title", "Reserved")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
  });

  it("resolves /panes/current for reads, writes, and terminal path actions", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: "term_live",
          summary: {
            alive: true,
            commandCount: 7,
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:05:00.000Z"
          }
        }
      ]
    });
    const model = host.createModel();

    const terminalState = await model.pathGet("/panes/current/terminal");
    expect(terminalState).toEqual({
      ok: true,
      found: true,
      value: {
        cwd: WORKSPACE_ROOT_DIR
      }
    });

    const terminalStateList = await model.pathList("/panes/current/terminal");
    expect(terminalStateList).toMatchObject({
      ok: true,
      found: true
    });
    if (terminalStateList.ok && terminalStateList.found) {
      expect(terminalStateList.entries.map((entry) => entry.name)).toEqual([
        "cwd",
        "create",
        "write",
        "resize",
        "history",
        "kill"
      ]);
    }

    expect(await model.pathList("/panes/current")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "kind", path: "/panes/current/kind", kind: "leaf", writable: false },
        { name: "title", path: "/panes/current/title", kind: "leaf", writable: true },
        { name: "close", path: "/panes/current/close", kind: "action", writable: false },
        { name: "terminal", path: "/panes/current/terminal", kind: "object", writable: false }
      ]
    });

    const terminalStatus = await model.pathGet("/status/panes/pane.term/terminal");
    expect(terminalStatus).toEqual({
      ok: true,
      found: true,
      value: {
        attached: true,
        rootKey: WORKSPACE_ROOT_KEY,
        cwd: WORKSPACE_ROOT_DIR,
        runtimeId: "term_live",
        alive: true,
        commandCount: 7,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:05:00.000Z"
      }
    });

    const terminalStatusList = await model.pathList("/status/panes/pane.term/terminal");
    expect(terminalStatusList).toMatchObject({
      ok: true,
      found: true
    });
    if (terminalStatusList.ok && terminalStatusList.found) {
      expect(terminalStatusList.entries.map((entry) => entry.name)).toEqual([
        "attached",
        "rootKey",
        "cwd",
        "runtimeId",
        "alive",
        "commandCount",
        "createdAt",
        "updatedAt"
      ]);
    }
    expect(await model.pathList("/status/panes/pane.term")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "id", path: "/status/panes/pane.term/id", kind: "leaf", writable: false },
        { name: "kind", path: "/status/panes/pane.term/kind", kind: "leaf", writable: false },
        { name: "title", path: "/status/panes/pane.term/title", kind: "leaf", writable: false },
        { name: "active", path: "/status/panes/pane.term/active", kind: "leaf", writable: false },
        { name: "terminal", path: "/status/panes/pane.term/terminal", kind: "object", writable: false }
      ]
    });

    const currentTerminalCwd = await model.pathGet("/panes/current/terminal/cwd");
    expect(currentTerminalCwd).toEqual({
      ok: true,
      found: true,
      value: WORKSPACE_ROOT_DIR
    });
    expect(await model.pathGet("/panes/current/runtimeId")).toEqual({
      ok: true,
      found: false,
      value: null
    });
    expect(await model.pathGet("/status/panes/pane.term/runtimeId")).toEqual({
      ok: true,
      found: false,
      value: null
    });

    const rename = await model.pathSet("/panes/current/title", "Renamed Terminal");
    expect(rename).toEqual({ ok: true, value: "Renamed Terminal" });
    expect(host.calls.setScopedProperty).toEqual([
      { target: { scope: "pane", paneId: "pane.term" }, key: "title", value: "Renamed Terminal" }
    ]);

    expect(await model.pathCall("/panes/current/terminal/create", { cwd: "." })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane already has an attached runtime"
    });
  });

  it("creates, drives, and detaches terminal runtimes only through explicit terminal actions", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: null,
          runtimeId: null
        }
      ]
    });
    const model = host.createModel();

    const created = await model.pathCall("/panes/current/terminal/create", { cwd: "." });
    expect(created).toMatchObject({
      ok: true,
      value: {
        ok: true,
        rootKey: WORKSPACE_ROOT_KEY,
        runtimeId: "term_created"
      }
    });
    expect(host.calls.createTerminalRuntime).toEqual([{ paneId: "pane.term", input: { cwd: "." } }]);

    expect(await model.pathCall("/panes/current/terminal/create", { cwd: "." })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane already has an attached runtime"
    });

    const wrote = await model.pathCall("/panes/current/terminal/write", { data: "echo hi\r" });
    expect(wrote).toMatchObject({
      ok: true,
      value: {
        ok: true,
        accepted: true,
        runtimeId: "term_created"
      }
    });
    expect(host.calls.writeTerminalRuntime).toEqual([{ paneId: "pane.term", input: { data: "echo hi\r" } }]);

    const resized = await model.pathCall("/panes/current/terminal/resize", { cols: 132, rows: 40 });
    expect(resized).toMatchObject({
      ok: true,
      value: {
        ok: true,
        accepted: true,
        runtimeId: "term_created"
      }
    });
    expect(host.calls.resizeTerminalRuntime).toEqual([{ paneId: "pane.term", input: { cols: 132, rows: 40 } }]);

    const history = await model.pathCall("/panes/current/terminal/history", { maxBytes: 256 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        ok: true,
        runtimeId: "term_created",
        data: "echo hi\r\n"
      }
    });
    expect(host.calls.readTerminalHistory).toEqual([{ paneId: "pane.term", input: { maxBytes: 256 } }]);

    const killed = await model.pathCall("/panes/current/terminal/kill");
    expect(killed).toMatchObject({
      ok: true,
      value: {
        ok: true,
        rootKey: WORKSPACE_ROOT_KEY,
        runtimeId: "term_created",
        killed: true
      }
    });
    expect(host.calls.killTerminalRuntime).toEqual(["pane.term"]);

    expect(await model.pathGet("/status/panes/pane.term/terminal")).toEqual({
      ok: true,
      found: true,
      value: {
        attached: false,
        rootKey: null,
        cwd: WORKSPACE_ROOT_DIR,
        runtimeId: null,
        alive: null,
        commandCount: null,
        createdAt: null,
        updatedAt: null
      }
    });
    expect(await model.pathCall("/panes/current/terminal/write", { data: "echo again\r" })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane is not attached to a runtime"
    });
    expect(await model.pathCall("/panes/current/terminal/resize", { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane is not attached to a runtime"
    });
    expect(await model.pathCall("/panes/current/terminal/history")).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane is not attached to a runtime"
    });
    expect(await model.pathCall("/panes/current/terminal/kill")).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Terminal pane is not attached to a runtime"
    });
  });

  it("kills attached runtimes before closing terminal panes", async () => {
    const killCalls: string[] = [];
    const terminalService = createSyntheticTerminalService();
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: null,
          runtimeId: null
        }
      ],
      terminalService: {
        create: (input) => terminalService.create(input),
        write: (input) => terminalService.write(input),
        resize: (input) => terminalService.resize(input),
        history: (input) => terminalService.history(input),
        kill: async (input) => {
          killCalls.push(input.runtimeId);
          return terminalService.kill(input);
        }
      }
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/current/terminal/create", { cwd: "." })).toMatchObject({
      ok: true,
      value: {
        ok: true,
        runtimeId: "term_created"
      }
    });

    expect(await model.pathCall("/panes/current/close")).toEqual({
      ok: true,
      value: {
        paneId: "pane.term",
        closed: true
      }
    });
    expect(killCalls).toEqual(["term_created"]);
    expect(await model.pathGet("/status/panes/pane.term")).toEqual({
      ok: true,
      found: false,
      value: null
    });
  });

  it("returns current-pane and terminal-kind errors directly from the model", async () => {
    const noCurrent = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: "C:\\workspace",
          rootDir: "C:\\workspace",
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: null
        }
      ]
    });
    const noCurrentModel = noCurrent.createModel();
    expect(await noCurrentModel.pathGet("/panes/current/title")).toEqual({
      ok: false,
      code: "NO_CURRENT_PANE",
      error: "No active pane is available"
    });

    const browserCurrent = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.browser",
      panes: [
        { id: "pane.browser", kind: "browser", title: "Browser", url: "https://example.test" }
      ]
    });
    const browserCurrentModel = browserCurrent.createModel();
    expect(await browserCurrentModel.pathCall("/panes/current/terminal/create", { cwd: "." })).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Terminal actions only apply to terminal panes"
    });
    expect(await browserCurrentModel.pathGet("/panes/current/browser/url")).toEqual({
      ok: true,
      found: true,
      value: "https://example.test"
    });
  });

  it("validates pane creation paths directly in the model", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    const defaultBrowser = await model.pathCall("/panes/new", { kind: "browser", place: "right" });
    expect(defaultBrowser).toMatchObject({
      ok: true,
      value: {
        path: expect.stringMatching(/^\/panes\/pane_/),
        pane: {
          kind: "browser",
          title: "Start",
          browser: {
            url: "http://127.0.0.1:4321/__flmux/internal/start?workspace=workspace.test"
          },
          active: true
        }
      }
    });
    expect(host.calls.createPane).toEqual([
      {
        kind: "browser",
        title: undefined,
        url: undefined,
        place: "right",
        cwd: undefined,
        params: undefined,
        referencePaneId: undefined
      }
    ]);
    host.calls.createPane.length = 0;

    expect(await model.pathCall("/panes/new", { kind: "missing.pane", place: "right" })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Unsupported pane kind 'missing.pane'"
    });

    expect(await model.pathCall("/panes/new", { kind: "cowsay", place: "diagonal" })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "Unsupported pane placement 'diagonal'"
    });

    const created = await model.pathCall("/panes/new", {
      kind: "browser",
      title: "Fixture Browser",
      url: "https://example.test",
      place: "right"
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        path: expect.stringMatching(/^\/panes\/pane_/),
        pane: {
          kind: "browser",
          title: "Fixture Browser",
          browser: {
            url: "https://example.test"
          },
          active: true
        }
      }
    });
    expect(host.calls.createPane).toEqual([
      {
        kind: "browser",
        title: "Fixture Browser",
        url: "https://example.test",
        place: "right",
        cwd: undefined,
        params: undefined,
        referencePaneId: undefined
      }
    ]);
  });

  it("passes registered custom pane kinds and extra params through /panes/new", async () => {
    class CustomPaneHost extends TestShellModelHost {
      override hasPaneKind(kind: string): boolean {
        return kind === "sample.chart" || super.hasPaneKind(kind);
      }

      override createPane(input: import("../src/renderer/shell/types").NewPaneInput) {
        this.calls.createPane.push(input);
        return {
          id: "pane.custom",
          kind: input.kind,
          title: input.title?.trim() || "Custom Pane",
          active: true
        };
      }
    }

    const host = new CustomPaneHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    const created = await model.pathCall("/panes/new", {
      kind: "sample.chart",
      title: "CPU Chart",
      place: "right",
      metric: "cpu",
      zoom: 2
    });
    expect(created).toEqual({
      ok: true,
      value: {
        paneId: "pane.custom",
        path: "/panes/pane.custom",
        pane: {
          id: "pane.custom",
          kind: "sample.chart",
          title: "CPU Chart",
          active: true
        }
      }
    });
    expect(host.calls.createPane).toEqual([
      {
        kind: "sample.chart",
        title: "CPU Chart",
        url: undefined,
        cwd: undefined,
        params: {
          metric: "cpu",
          zoom: 2
        },
        place: "right",
        referencePaneId: undefined
      }
    ]);
  });

  it("does not auto-expose built-in-specific state paths for generic panes like cowsay", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.cowsay",
      panes: [
        {
          id: "pane.cowsay",
          kind: "cowsay",
          title: "Cowsay"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathGet("/panes/pane.cowsay/browser")).toEqual({
      ok: true,
      found: false,
      value: null
    });
    expect(await model.pathGet("/status/panes/pane.cowsay/browser")).toEqual({
      ok: true,
      found: false,
      value: null
    });
    expect(await model.pathList("/panes/pane.cowsay/browser")).toEqual({
      ok: true,
      found: false,
      entries: []
    });
    expect(await model.pathList("/status/panes/pane.cowsay/browser")).toEqual({
      ok: true,
      found: false,
      entries: []
    });
    expect(await model.pathGet("/panes/pane.cowsay/terminal")).toEqual({
      ok: true,
      found: false,
      value: null
    });
    expect(await model.pathList("/panes/pane.cowsay")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "kind", path: "/panes/pane.cowsay/kind", kind: "leaf", writable: false },
        { name: "title", path: "/panes/pane.cowsay/title", kind: "leaf", writable: true },
        { name: "close", path: "/panes/pane.cowsay/close", kind: "action", writable: false }
      ]
    });
  });

  it("mounts scratchpad pane-local subtree without aliases and persists through shell-owned params", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.scratchpad",
      panes: [
        {
          id: "pane.scratchpad",
          kind: "scratchpad",
          title: "Scratchpad",
          note: "seed"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathList("/panes/pane.scratchpad")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "kind", path: "/panes/pane.scratchpad/kind", kind: "leaf", writable: false },
        { name: "title", path: "/panes/pane.scratchpad/title", kind: "leaf", writable: true },
        { name: "close", path: "/panes/pane.scratchpad/close", kind: "action", writable: false },
        { name: "scratchpad", path: "/panes/pane.scratchpad/scratchpad", kind: "object", writable: false }
      ]
    });
    expect(await model.pathGet("/panes/pane.scratchpad/scratchpad")).toEqual({
      ok: true,
      found: true,
      value: {
        note: "seed"
      }
    });
    expect(await model.pathList("/panes/pane.scratchpad/scratchpad")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "note", path: "/panes/pane.scratchpad/scratchpad/note", kind: "leaf", writable: true }
      ]
    });
    expect(await model.pathGet("/status/panes/pane.scratchpad/scratchpad")).toEqual({
      ok: true,
      found: true,
      value: {
        noteLength: 4
      }
    });
    expect(await model.pathList("/status/panes/pane.scratchpad/scratchpad")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "noteLength", path: "/status/panes/pane.scratchpad/scratchpad/noteLength", kind: "leaf", writable: false }
      ]
    });
    expect(await model.pathGet("/panes/pane.scratchpad/note")).toEqual({
      ok: true,
      found: false,
      value: null
    });

    expect(await model.pathSet("/panes/pane.scratchpad/scratchpad/note", "patched")).toEqual({
      ok: true,
      value: "patched"
    });
    expect(host.calls.setPaneParams).toEqual([
      {
        paneId: "pane.scratchpad",
        nextParams: {
          note: "patched"
        }
      }
    ]);
    expect(await model.pathGet("/panes/pane.scratchpad/scratchpad/note")).toEqual({
      ok: true,
      found: true,
      value: "patched"
    });
    expect(await model.pathGet("/status/panes/pane.scratchpad/scratchpad/noteLength")).toEqual({
      ok: true,
      found: true,
      value: 7
    });
  });

  it("mounts inspector as a read-only custom subtree", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.inspector",
      panes: [
        {
          id: "pane.inspector",
          kind: "inspector",
          title: "Inspector",
          subscription: "inspector.*"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathList("/panes/pane.inspector")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "kind", path: "/panes/pane.inspector/kind", kind: "leaf", writable: false },
        { name: "title", path: "/panes/pane.inspector/title", kind: "leaf", writable: true },
        { name: "close", path: "/panes/pane.inspector/close", kind: "action", writable: false },
        { name: "inspector", path: "/panes/pane.inspector/inspector", kind: "object", writable: false }
      ]
    });
    expect(await model.pathGet("/panes/pane.inspector/inspector")).toEqual({
      ok: true,
      found: true,
      value: {
        subscription: "inspector.*"
      }
    });
    expect(await model.pathList("/panes/pane.inspector/inspector")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "subscription", path: "/panes/pane.inspector/inspector/subscription", kind: "leaf", writable: false }
      ]
    });
    expect(await model.pathGet("/status/panes/pane.inspector/inspector")).toEqual({
      ok: true,
      found: true,
      value: {
        workspaceId: "workspace.test",
        rootDir: WORKSPACE_ROOT_DIR,
        defaultBrowserPath: "/__flmux/internal/start?workspace=workspace.test"
      }
    });
    expect(await model.pathSet("/panes/pane.inspector/inspector/subscription", "other.*")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
  });

  it("only marks custom mount leaves writable when the mount explicitly allows them", async () => {
    class SelectiveMountHost extends TestShellModelHost {
      override getPanePathMount(paneId: string) {
        if (paneId !== "pane.custom") {
          return super.getPanePathMount(paneId);
        }

        return {
          mountKey: "sample",
          getStateSnapshot: () => ({
            writableLeaf: "ok",
            readonlyLeaf: "nope"
          }),
          canSetStatePath: (relativePath: string[]) =>
            relativePath.length === 1 && relativePath[0] === "writableLeaf",
          setState: (relativePath: string[], value: unknown) => {
            if (relativePath.length !== 1 || relativePath[0] !== "writableLeaf") {
              throw new Error(`unexpected path '${relativePath.join("/")}'`);
            }

            return { value };
          },
          getStatusSnapshot: () => ({
            readonlyLeafLength: 4
          })
        };
      }
    }

    const host = new SelectiveMountHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.custom",
      panes: [
        {
          id: "pane.custom",
          kind: "inspector",
          title: "Selective Mount"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathList("/panes/pane.custom/sample")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "writableLeaf", path: "/panes/pane.custom/sample/writableLeaf", kind: "leaf", writable: true },
        { name: "readonlyLeaf", path: "/panes/pane.custom/sample/readonlyLeaf", kind: "leaf", writable: false }
      ]
    });
    expect(await model.pathSet("/panes/pane.custom/sample/readonlyLeaf", "blocked")).toEqual({
      ok: false,
      code: "NOT_WRITABLE",
      error: "Path is not writable"
    });
  });

  it("requires runtime caller context for bus publish and preserves named payload fields", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootDir: WORKSPACE_ROOT_DIR,
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: "term_live"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathCall("/bus/publish", { topic: "plot.selection.changed", x: 123 })).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "call /bus/publish requires runtime caller context"
    });

    const published = await model.pathCall(
      "/bus/publish",
      { topic: "plot.selection.changed", x: 123, series: "cpu" },
      { sourcePaneId: "pane.term" }
    );
    expect(published).toMatchObject({
      ok: true,
      value: {
        ok: true,
        published: {
          topic: "plot.selection.changed",
          sourcePaneId: "pane.term",
          payload: { x: 123, series: "cpu" },
          workspaceId: "workspace.test"
        }
      }
    });
    expect(host.calls.publishWorkspaceEvent).toEqual([
      {
        topic: "plot.selection.changed",
        sourcePaneId: "pane.term",
        payload: { x: 123, series: "cpu" }
      }
    ]);
  });

  it("keeps synthetic terminal helper aligned with stale runtime semantics", async () => {
    const service = createSyntheticTerminalService();

    const created = await service.create({
      rootDir: WORKSPACE_ROOT_DIR,
      cwd: "."
    });
    expect(created.rootKey).toBe(WORKSPACE_ROOT_KEY);

    expect(await service.kill({
      rootKey: created.rootKey,
      runtimeId: created.runtimeId
    })).toEqual({
      ok: true,
      rootKey: WORKSPACE_ROOT_KEY,
      runtimeId: created.runtimeId,
      killed: true,
      terminal: null
    });

    expect(await service.write({
      rootKey: created.rootKey,
      runtimeId: created.runtimeId,
      data: "echo hi\r"
    })).toEqual({
      ok: true,
      accepted: false,
      runtimeId: created.runtimeId,
      history: "",
      terminal: null
    });

    expect(await service.kill({
      rootKey: created.rootKey,
      runtimeId: created.runtimeId
    })).toEqual({
      ok: true,
      rootKey: WORKSPACE_ROOT_KEY,
      runtimeId: created.runtimeId,
      killed: false,
      terminal: null
    });
  });
});
