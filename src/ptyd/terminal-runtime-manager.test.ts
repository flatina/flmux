import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IPty } from "bun-pty";
import { createTerminalRuntimeId, type SessionId } from "../lib/ids";
import { TerminalRuntimeManager } from "./terminal-runtime-manager";

function createMockPty() {
  const writes: string[] = [];
  let onDataHandler: ((data: string) => void) | null = null;
  let onExitHandler: ((event: { exitCode?: number | null }) => void) | null = null;

  const pty = {
    write(data: string) {
      writes.push(data);
    },
    kill() {},
    resize() {},
    onData(handler: (data: string) => void) {
      onDataHandler = handler;
      return { dispose() {} };
    },
    onExit(handler: (event: { exitCode?: number | null }) => void) {
      onExitHandler = handler;
      return { dispose() {} };
    }
  } as unknown as IPty;

  return {
    pty,
    writes,
    emitData(data: string) {
      onDataHandler?.(data);
    },
    emitExit(exitCode: number | null = 0) {
      onExitHandler?.({ exitCode });
    }
  };
}

describe("TerminalRuntimeManager startup queue", () => {
  test("runs hooks before requested startup commands", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "flmux-term-hooks-"));
    try {
      writeFileSync(
        join(workspaceRoot, "flmux-hooks.yaml"),
        "terminal:\n  init:\n    - echo hook-one\n    - echo hook-two\n",
        "utf-8"
      );

      const mock = createMockPty();
      const manager = new TerminalRuntimeManager({
        defaultCwd: workspaceRoot,
        sessionId: "test-session" as SessionId,
        spawnPty: (() => mock.pty) as typeof import("bun-pty").spawn,
        pushTerminalEvent: () => {}
      });

      const result = manager.createTerminal({
        runtimeId: createTerminalRuntimeId(),
        cwd: workspaceRoot,
        workspaceRoot,
        startupCommands: ["echo app-cmd"]
      });

      expect(result.created).toBe(true);
      expect(mock.writes).toEqual([]);

      mock.emitData("prompt>");

      expect(mock.writes).toEqual(["echo hook-one\r", "echo hook-two\r", "echo app-cmd\r"]);

      mock.emitData("next");
      expect(mock.writes).toEqual(["echo hook-one\r", "echo hook-two\r", "echo app-cmd\r"]);

      manager.dispose();
      mock.emitExit(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not replay startup commands when createTerminal is called again for the same runtime", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "flmux-term-retry-"));
    try {
      const mock = createMockPty();
      const manager = new TerminalRuntimeManager({
        defaultCwd: workspaceRoot,
        sessionId: "test-session" as SessionId,
        spawnPty: (() => mock.pty) as typeof import("bun-pty").spawn,
        pushTerminalEvent: () => {}
      });

      const runtimeId = createTerminalRuntimeId();
      const first = manager.createTerminal({
        runtimeId,
        cwd: workspaceRoot,
        workspaceRoot,
        startupCommands: ["echo first"]
      });
      expect(first.created).toBe(true);
      mock.emitData("prompt>");
      expect(mock.writes).toEqual(["echo first\r"]);

      const second = manager.createTerminal({
        runtimeId,
        cwd: workspaceRoot,
        workspaceRoot,
        startupCommands: ["echo second"]
      });
      expect(second.created).toBe(false);

      mock.emitData("later");
      expect(mock.writes).toEqual(["echo first\r"]);

      manager.dispose();
      mock.emitExit(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not recreate an exited runtime with the same runtimeId", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "flmux-term-exit-"));
    try {
      const mock = createMockPty();
      const manager = new TerminalRuntimeManager({
        defaultCwd: workspaceRoot,
        sessionId: "test-session" as SessionId,
        spawnPty: (() => mock.pty) as typeof import("bun-pty").spawn,
        pushTerminalEvent: () => {}
      });

      const runtimeId = createTerminalRuntimeId();
      const first = manager.createTerminal({
        runtimeId,
        cwd: workspaceRoot,
        workspaceRoot,
        startupCommands: ["echo first"]
      });
      expect(first.created).toBe(true);
      mock.emitData("prompt>");
      mock.emitExit(0);

      const second = manager.createTerminal({
        runtimeId,
        cwd: workspaceRoot,
        workspaceRoot,
        startupCommands: ["echo second"]
      });

      expect(second.created).toBe(false);
      expect(second.terminal.status).toBe("exited");
      expect(mock.writes).toEqual(["echo first\r"]);

      manager.dispose();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
