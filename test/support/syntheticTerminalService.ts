import type {
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalRuntimeSummary,
  TerminalWriteResult
} from "../../src/shared/terminal";
import { toTerminalRootKey } from "../../src/main/terminal-service/rootKey";
import { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "../../src/shared/terminalPath";

export interface SyntheticTerminalService {
  create(input: { paneId?: string; rootDir: string; cwd?: string }): Promise<TerminalCreateResult>;
  write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult>;
  history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult>;
  kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult>;
}

export interface SyntheticTerminalServiceOptions {
  rootKey?: string;
}

export function createSyntheticTerminalService(options: SyntheticTerminalServiceOptions = {}): SyntheticTerminalService {
  let nextId = 1;
  const runtimes = new Map<string, { rootKey: string; rootDir: string; cwd: string; alive: boolean; commandCount: number }>();

  return {
    async create(input) {
      const runtimeId = nextId === 1 ? "term_created" : `term_${nextId}`;
      nextId += 1;
      const rootDir = normalizeTerminalRootDir(input.rootDir);
      const rootKey = options.rootKey ?? toTerminalRootKey(rootDir);
      const cwd = resolveTerminalCwdFromRoot(rootDir, input.cwd);
      runtimes.set(runtimeId, { rootKey, rootDir, cwd, alive: true, commandCount: 0 });

      return {
        ok: true,
        rootKey,
        runtimeId,
        history: "",
        terminal: makeSummary({ rootKey, rootDir, runtimeId, cwd, alive: true, commandCount: 0 })
      };
    },

    async write(input) {
      const runtime = runtimes.get(input.runtimeId);
      if (!runtime || runtime.rootKey !== input.rootKey || !runtime.alive) {
        return {
          ok: true,
          accepted: false,
          runtimeId: input.runtimeId,
          history: "",
          terminal: null
        };
      }

      runtime.commandCount += 1;

      return {
        ok: true,
        accepted: true,
        runtimeId: input.runtimeId,
        history: input.data,
        terminal: runtime
          ? makeSummary({
              rootKey: input.rootKey,
              rootDir: runtime.rootDir,
              runtimeId: input.runtimeId,
              cwd: runtime.cwd,
              alive: true,
              commandCount: runtime.commandCount
            })
          : null
      };
    },

    async history(input) {
      const runtime = runtimes.get(input.runtimeId);
      if (!runtime || runtime.rootKey !== input.rootKey) {
        return {
          ok: true,
          runtimeId: input.runtimeId,
          data: ""
        };
      }

      return {
        ok: true,
        runtimeId: input.runtimeId,
        data: "echo hi\r\n"
      };
    },

    async kill(input) {
      const runtime = runtimes.get(input.runtimeId);
      if (!runtime || runtime.rootKey !== input.rootKey) {
        return {
          ok: true,
          rootKey: input.rootKey,
          runtimeId: input.runtimeId,
          killed: false,
          terminal: null
        };
      }

      runtimes.delete(input.runtimeId);

      return {
        ok: true,
        rootKey: input.rootKey,
        runtimeId: input.runtimeId,
        killed: true,
        terminal: null
      };
    }
  };
}

function makeSummary(input: {
  rootKey: string;
  rootDir: string;
  runtimeId: string;
  cwd: string;
  alive: boolean;
  commandCount: number;
}): TerminalRuntimeSummary {
  return {
    rootKey: input.rootKey,
    rootDir: input.rootDir,
    runtimeId: input.runtimeId,
    cwd: input.cwd,
    alive: input.alive,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    commandCount: input.commandCount
  };
}
