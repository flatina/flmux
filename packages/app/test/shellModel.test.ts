import { describe, expect, it } from "bun:test";
import { ModelPathError } from "@flmux/core/shell";
import { toTerminalRootKey } from "@flmux/core/terminal/rootKey";
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
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: "term_live"
        }
      ]
    });
    const model = host.createModel();

    const workspaceStatus = await model.pathGet("/status/workspace", { attachmentId: "test" });
    expect(workspaceStatus).toEqual({
      ok: true,
      found: true,
      value: {
        id: "workspace.test",
        title: "Workspace Test",
        defaultTitle: "Workspace Test",
        paneCount: 2
      }
    });

    const paneList = await model.pathList("/panes", { attachmentId: "test" });
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

  it("implicit-current reads/writes require caller.attachmentId; external callers get INVALID_VALUE (B3)", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    expect(await model.pathGet("/status/workspace")).toMatchObject({ ok: false, code: "INVALID_VALUE" });
    expect(await model.pathList("/panes")).toMatchObject({ ok: false, code: "INVALID_VALUE" });
    expect(await model.pathGet("/status/panes")).toMatchObject({ ok: false, code: "INVALID_VALUE" });
    expect(await model.pathSet("/title", "Rename")).toMatchObject({ ok: false, code: "INVALID_VALUE" });
  });

  it("exposes /status/attachments/* and /status/workspaces/{id}/* explicit-target reads (B1e)", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.alpha",
      panes: [{ id: "pane.alpha", kind: "cowsay", title: "Cowsay" }]
    });
    const model = host.createModel();

    const attachments = await model.pathGet("/status/attachments");
    expect(attachments).toMatchObject({ ok: true, found: true });
    if (attachments.ok && attachments.found) {
      expect(attachments.value).toEqual({
        test: {
          attachmentId: "test",
          userId: "test-user",
          activeWorkspaceId: "workspace.test",
          activePaneIdByWorkspace: { "workspace.test": "pane.alpha" }
        }
      });
    }

    const current = await model.pathGet("/status/attachments/test/currentWorkspace");
    expect(current).toMatchObject({
      ok: true,
      found: true,
      value: { id: "workspace.test", title: "Workspace Test", paneCount: 1 }
    });

    const currentTitle = await model.pathGet("/status/attachments/test/currentWorkspace/title");
    expect(currentTitle).toEqual({ ok: true, found: true, value: "Workspace Test" });

    const explicit = await model.pathGet("/status/workspaces/workspace.test");
    expect(explicit).toMatchObject({
      ok: true,
      found: true,
      value: { id: "workspace.test", title: "Workspace Test", paneCount: 1 }
    });

    const explicitPanes = await model.pathGet("/status/workspaces/workspace.test/panes");
    expect(explicitPanes).toMatchObject({ ok: true, found: true });
    if (explicitPanes.ok && explicitPanes.found) {
      expect(Object.keys(explicitPanes.value as Record<string, unknown>)).toEqual(["pane.alpha"]);
    }

    const missingWorkspace = await model.pathGet("/status/workspaces/workspace.unknown");
    expect(missingWorkspace).toMatchObject({ ok: true, found: false });

    const missingAttachment = await model.pathGet("/status/attachments/web_does_not_exist");
    expect(missingAttachment).toMatchObject({ ok: true, found: false });

    const attachmentsList = await model.pathList("/status/attachments");
    expect(attachmentsList).toMatchObject({ ok: true, found: true });
    if (attachmentsList.ok && attachmentsList.found) {
      expect(attachmentsList.entries.map((entry) => entry.name)).toEqual(["test"]);
    }
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
    expect(await model.pathGet("/status/workspace", { attachmentId: "test" })).toEqual({
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

    const status = await model.pathGet("/status/workspace", { attachmentId: "test" });
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
    expect(await model.pathSet("/title", "Workspace Renamed", { attachmentId: "test" })).toEqual({
      ok: true,
      value: "Workspace Renamed"
    });
    expect(await model.pathSet("/workspaces/workspace.test/title", "Workspace Explicit")).toEqual({
      ok: true,
      value: "Workspace Explicit"
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
      entries: [{ name: "url", path: "/panes/pane.browser/browser/url", kind: "leaf", writable: true }]
    });
    expect(await model.pathList("/workspaces/workspace.test")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "id", path: "/workspaces/workspace.test/id", kind: "leaf", writable: false },
        { name: "title", path: "/workspaces/workspace.test/title", kind: "leaf", writable: true },
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
      { target: { scope: "workspace", workspaceId: "workspace.test" }, key: "title", value: "Workspace Renamed" },
      { target: { scope: "workspace", workspaceId: "workspace.test" }, key: "title", value: "Workspace Explicit" }
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
      code: "NOT_FOUND",
      error: "Workspace 'workspace.missing' not found"
    });
    expect(await model.pathSet("/workspaces/new/title", "Reserved")).toEqual({
      ok: false,
      code: "NOT_FOUND",
      error: "Workspace 'new' not found"
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
        "attach",
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

    // attach is idempotent (multi-subscriber / reload support): a second
    // attach on the same pane no longer throws. The test host's terminal
    // delegate re-enters createTerminalRuntime — the shape we care about
    // in real code is the shellCore-level idempotent branch; here we
    // just assert the pathCall doesn't reject.
    const reAttach = await model.pathCall("/panes/current/terminal/attach", { cwd: "." });
    expect(reAttach.ok).toBe(true);
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
          rootKey: null,
          runtimeId: null
        }
      ]
    });
    const model = host.createModel();

    const created = await model.pathCall("/panes/current/terminal/attach", { cwd: "." });
    expect(created).toMatchObject({
      ok: true,
      value: {
        ok: true,
        rootKey: WORKSPACE_ROOT_KEY,
        runtimeId: "term_created"
      }
    });
    expect(host.calls.createTerminalRuntime).toEqual([{ paneId: "pane.term", input: { cwd: "." } }]);

    // Idempotent attach: no rejection. (shellCore's real delegate
    // returns the existing runtime snapshot; the test mock re-enters
    // createTerminalRuntime, which is fine for the pathCall surface.)
    const reAttach = await model.pathCall("/panes/current/terminal/attach", { cwd: "." });
    expect(reAttach.ok).toBe(true);

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
    // Idempotent re-attach above also reads history (to return it to the
    // caller) — the final call we care about is the explicit one.
    expect(host.calls.readTerminalHistory.at(-1)).toEqual({ paneId: "pane.term", input: { maxBytes: 256 } });

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

    expect(await model.pathCall("/panes/current/terminal/attach", { cwd: "." })).toMatchObject({
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
      panes: [{ id: "pane.browser", kind: "browser", title: "Browser", url: "https://example.test" }]
    });
    const browserCurrentModel = browserCurrent.createModel();
    expect(await browserCurrentModel.pathCall("/panes/current/terminal/attach", { cwd: "." })).toEqual({
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
          }
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
          }
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

      override createPane(input: import("@flmux/core/shell/types").NewPaneInput) {
        this.calls.createPane.push(input);
        return {
          id: "pane.custom",
          kind: input.kind,
          title: input.title?.trim() || "Custom Pane"
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
          title: "CPU Chart"
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
      entries: [{ name: "note", path: "/panes/pane.scratchpad/scratchpad/note", kind: "leaf", writable: true }]
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
        {
          name: "noteLength",
          path: "/status/panes/pane.scratchpad/scratchpad/noteLength",
          kind: "leaf",
          writable: false
        }
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

  it("exposes scratchpad stats + clear as callState ops on the same mount", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.scratchpad",
      panes: [
        {
          id: "pane.scratchpad",
          kind: "scratchpad",
          title: "Scratchpad",
          note: "hello world\nhow are you"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.scratchpad/scratchpad/stats", {})).toEqual({
      ok: true,
      value: { chars: 23, words: 5, lines: 2 }
    });
    expect(await model.pathGet("/panes/pane.scratchpad/scratchpad/note")).toEqual({
      ok: true,
      found: true,
      value: "hello world\nhow are you"
    });

    expect(await model.pathCall("/panes/pane.scratchpad/scratchpad/clear", {})).toEqual({
      ok: true,
      value: { cleared: true }
    });
    expect(await model.pathGet("/panes/pane.scratchpad/scratchpad/note")).toEqual({
      ok: true,
      found: true,
      value: ""
    });

    expect(await model.pathCall("/panes/pane.scratchpad/scratchpad/unknown", {})).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
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
          canSetStatePath: (relativePath: string[]) => relativePath.length === 1 && relativePath[0] === "writableLeaf",
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

  it("routes /panes/<id>/<mountKey>/<op> calls through pathMount callState with ACL + error mapping", async () => {
    const callLog: Array<{ relativePath: string[]; args: Record<string, unknown> }> = [];

    class CallableMountHost extends TestShellModelHost {
      override getPanePathMount(paneId: string) {
        if (paneId !== "pane.custom") {
          return super.getPanePathMount(paneId);
        }

        return {
          mountKey: "query",
          getStateSnapshot: () => ({ ready: true }),
          canCallStatePath: (relativePath: string[]) =>
            relativePath.length === 1 && ["echo", "boom", "bad-arg", "silent"].includes(relativePath[0]!),
          callState: async (relativePath: string[], args: Record<string, unknown>) => {
            callLog.push({ relativePath, args });
            const op = relativePath[0];
            if (op === "echo") return { value: { op, args } };
            if (op === "boom") throw new Error("kaboom");
            if (op === "bad-arg") throw new ModelPathError("INVALID_VALUE", "arg rejected");
            if (op === "silent") return { value: null };
            throw new Error(`unexpected op ${op}`);
          },
          getStatusSnapshot: () => ({ calls: callLog.length })
        };
      }
    }

    const host = new CallableMountHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.custom",
      panes: [{ id: "pane.custom", kind: "inspector", title: "Callable Mount" }]
    });
    const model = host.createModel();

    // Success: computed value is returned verbatim under {ok: true, value}.
    expect(await model.pathCall("/panes/pane.custom/query/echo", { n: 7 })).toEqual({
      ok: true,
      value: { op: "echo", args: { n: 7 } }
    });
    expect(callLog.at(-1)).toEqual({ relativePath: ["echo"], args: { n: 7 } });

    // Generic Error → wrapped as INTERNAL_ERROR with the original message.
    expect(await model.pathCall("/panes/pane.custom/query/boom", {})).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "kaboom"
    });

    // ModelPathError thrown inside callState keeps its code (so extensions can
    // surface user-input errors as INVALID_VALUE rather than INTERNAL_ERROR).
    expect(await model.pathCall("/panes/pane.custom/query/bad-arg", {})).toEqual({
      ok: false,
      code: "INVALID_VALUE",
      error: "arg rejected"
    });

    // canCallStatePath returning false → NOT_CALLABLE, callState never runs.
    const callsBefore = callLog.length;
    expect(await model.pathCall("/panes/pane.custom/query/unknown", {})).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
    });
    expect(callLog.length).toBe(callsBefore);

    // `/panes/<id>/<mountKey>` with no op is length 3; it never enters the
    // mount-dispatch branch (which gates on length >= 4) and lands on the
    // final NOT_CALLABLE throw, so the mount's callState is not invoked.
    expect(await model.pathCall("/panes/pane.custom/query", {})).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
    });
  });

  it("default-denies when callState is defined without canCallStatePath", async () => {
    class MissingGateHost extends TestShellModelHost {
      override getPanePathMount(paneId: string) {
        if (paneId !== "pane.custom") {
          return super.getPanePathMount(paneId);
        }

        return {
          mountKey: "query",
          getStateSnapshot: () => ({}),
          // Intentionally omit canCallStatePath to pin the default-deny behavior.
          callState: () => ({ value: "should-not-run" }),
          getStatusSnapshot: () => ({})
        };
      }
    }

    const host = new MissingGateHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.custom",
      panes: [{ id: "pane.custom", kind: "inspector", title: "Missing Gate" }]
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.custom/query/anything", {})).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
    });
  });

  it("returns NOT_CALLABLE when the mount has no callState defined", async () => {
    class ReadOnlyMountHost extends TestShellModelHost {
      override getPanePathMount(paneId: string) {
        if (paneId !== "pane.custom") {
          return super.getPanePathMount(paneId);
        }

        return {
          mountKey: "sample",
          getStateSnapshot: () => ({ ready: true }),
          getStatusSnapshot: () => ({ ready: true })
        };
      }
    }

    const host = new ReadOnlyMountHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.custom",
      panes: [{ id: "pane.custom", kind: "inspector", title: "Read-only Mount" }]
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.custom/sample/any", {})).toEqual({
      ok: false,
      code: "NOT_CALLABLE",
      error: "Path is not callable"
    });
  });

  it("routes callState through a subtreeMount so panes with built-in subtrees can expose RPC", async () => {
    class SubtreeCallableHost extends TestShellModelHost {
      override getPaneSubtreeMounts(paneId: string) {
        const base = super.getPaneSubtreeMounts(paneId);
        if (paneId !== "pane.browser") return base;

        return [
          ...base,
          {
            mountKey: "probe",
            getStateSnapshot: () => ({}),
            canCallStatePath: (relativePath: string[]) => relativePath.length === 1 && relativePath[0] === "ping",
            callState: (relativePath: string[], args: Record<string, unknown>) => ({
              value: { relativePath, args }
            }),
            getStatusSnapshot: () => ({})
          }
        ];
      }
    }

    const host = new SubtreeCallableHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.browser",
      panes: [{ id: "pane.browser", kind: "browser", title: "Browser", url: "https://example.test" }]
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.browser/probe/ping", { n: 1 })).toEqual({
      ok: true,
      value: { relativePath: ["ping"], args: { n: 1 } }
    });
  });

  it("exposes /status/ext/<id>/data-dir from the host resolver", async () => {
    class ExtDataDirHost extends TestShellModelHost {
      readonly resolved: string[] = [];
      override resolveExtensionDataDir(extensionId: string): string | null {
        this.resolved.push(extensionId);
        if (extensionId === "registered.ext") return "C:\\flmux\\.flmux\\ext\\registered.ext";
        return null;
      }
    }

    const host = new ExtDataDirHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.term",
      panes: [
        {
          id: "pane.term",
          kind: "terminal",
          title: "Terminal",
          cwd: WORKSPACE_ROOT_DIR,
          rootKey: WORKSPACE_ROOT_KEY,
          runtimeId: "term_live"
        }
      ]
    });
    const model = host.createModel();

    expect(await model.pathGet("/status/ext/registered.ext/data-dir")).toEqual({
      ok: true,
      found: true,
      value: "C:\\flmux\\.flmux\\ext\\registered.ext"
    });

    expect(await model.pathGet("/status/ext/registered.ext")).toEqual({
      ok: true,
      found: true,
      value: { dataDir: "C:\\flmux\\.flmux\\ext\\registered.ext" }
    });

    expect(await model.pathList("/status/ext/registered.ext")).toEqual({
      ok: true,
      found: true,
      entries: [
        { name: "data-dir", path: "/status/ext/registered.ext/data-dir", kind: "leaf", writable: false }
      ]
    });

    expect(await model.pathGet("/status/ext/missing.ext/data-dir")).toMatchObject({
      ok: true,
      found: false
    });

    // /status/ext root is intentionally not enumerable — no listing contract
    // for "what extensions are loaded".
    expect(await model.pathGet("/status/ext")).toMatchObject({ ok: true, found: false });
    expect(await model.pathList("/status/ext")).toMatchObject({ ok: true, found: false });

    expect(await model.pathGet("/status/ext/registered.ext/garbage")).toMatchObject({
      ok: true,
      found: false
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

    expect(
      await service.kill({
        rootKey: created.rootKey,
        runtimeId: created.runtimeId
      })
    ).toEqual({
      ok: true,
      rootKey: WORKSPACE_ROOT_KEY,
      runtimeId: created.runtimeId,
      killed: true,
      terminal: null
    });

    expect(
      await service.write({
        rootKey: created.rootKey,
        runtimeId: created.runtimeId,
        data: "echo hi\r"
      })
    ).toEqual({
      ok: true,
      accepted: false,
      runtimeId: created.runtimeId,
      history: "",
      terminal: null
    });

    expect(
      await service.kill({
        rootKey: created.rootKey,
        runtimeId: created.runtimeId
      })
    ).toEqual({
      ok: true,
      rootKey: WORKSPACE_ROOT_KEY,
      runtimeId: created.runtimeId,
      killed: false,
      terminal: null
    });
  });

  it("merges /panes/{id}/params:patch args into existing params via patchPaneParams", async () => {
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

    expect(await model.pathCall("/panes/pane.scratchpad/params:patch", { note: "patched", extra: "keep" })).toEqual({
      ok: true,
      value: {
        note: "patched",
        extra: "keep"
      }
    });
    expect(host.calls.patchPaneParams).toEqual([
      { paneId: "pane.scratchpad", patch: { note: "patched", extra: "keep" } }
    ]);
  });

  it("rejects /panes/{id}/params:patch on unknown pane id", async () => {
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

    expect(await model.pathCall("/panes/pane.missing/params:patch", { note: "x" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND"
    });
  });

  it("routes /workspaces/{id}/setActive through host.setActiveWorkspace", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    expect(await model.pathCall("/workspaces/workspace.other/setActive")).toEqual({
      ok: true,
      value: { workspaceId: "workspace.other" }
    });
  });

  it("routes /workspaces/{id}/delete through host.deleteWorkspace", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    expect(await model.pathCall("/workspaces/workspace.test/delete")).toEqual({
      ok: true,
      value: { workspaceId: "workspace.test", deleted: true }
    });
  });

  it("routes /panes/{id}/setActive through host.setActivePane", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: "pane.a",
      panes: [
        { id: "pane.a", kind: "browser", title: "A", url: "/a" },
        { id: "pane.b", kind: "browser", title: "B", url: "/b" }
      ]
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.b/setActive")).toEqual({
      ok: true,
      value: { paneId: "pane.b" }
    });
  });

  it("rejects /panes/{id}/setActive on unknown pane id", async () => {
    const host = new TestShellModelHost({
      workspaceId: "workspace.test",
      workspaceTitle: "Workspace Test",
      activePaneId: null,
      panes: []
    });
    const model = host.createModel();

    expect(await model.pathCall("/panes/pane.missing/setActive")).toMatchObject({
      ok: false,
      code: "NOT_FOUND"
    });
  });
});
