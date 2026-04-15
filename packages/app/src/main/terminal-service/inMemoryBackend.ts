import { mkdir } from "node:fs/promises";
import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalRootStatus,
  TerminalRuntimeEvent,
  TerminalRuntimeSummary,
  TerminalWriteResult
} from "../../shared/terminal";
import type { TerminalBackend } from "./backend";
import { toTerminalRootKey } from "./rootKey";
import { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "../../shared/terminalPath";

interface TerminalRuntimeRecord {
  ownerPaneId: string | null;
  summary: TerminalRuntimeSummary;
  history: string;
  lines: string[];
}

interface TerminalRootRecord {
  status: TerminalRootStatus;
  runtimes: Map<string, TerminalRuntimeRecord>;
}

export function createInMemoryTerminalBackend(): TerminalBackend {
  return new InMemoryTerminalBackend();
}

class InMemoryTerminalBackend implements TerminalBackend {
  private readonly roots = new Map<string, TerminalRootRecord>();
  private readonly subscribers = new Set<(event: TerminalRuntimeEvent) => void>();
  private readonly runtimeOwners = new Map<string, string | null>();

  async adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult> {
    const rootDir = normalizeTerminalRootDir(input.rootDir);
    const rootKey = toTerminalRootKey(rootDir);
    const root = this.roots.get(rootKey);
    if (!root) {
      return {
        ok: true,
        outcome: "not_found"
      };
    }

    const matches = [...root.runtimes.values()].filter((runtime) => runtime.ownerPaneId === input.paneId);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.warn(`multiple runtimes matched ownerPaneId '${input.paneId}' in root '${rootKey}'`);
      }
      return {
        ok: true,
        outcome: "not_found"
      };
    }

    const runtime = matches[0];
    this.runtimeOwners.set(runtime.summary.runtimeId, input.paneId);
    return {
      ok: true,
      outcome: "adopted",
      rootKey,
      runtimeId: runtime.summary.runtimeId,
      history: runtime.history,
      terminal: cloneSummary(runtime.summary)
    };
  }

  async create(input: TerminalCreateInput): Promise<TerminalCreateResult> {
    const rootDir = normalizeTerminalRootDir(input.rootDir);
    const rootKey = toTerminalRootKey(rootDir);
    const root = this.getOrCreateRoot(rootDir, rootKey);
    const runtimeId = `term_${crypto.randomUUID()}`;
    const cwd = resolveTerminalCwdFromRoot(rootDir, input.cwd);
    await mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();

    if (input.paneId && [...root.runtimes.values()].some((runtime) => runtime.ownerPaneId === input.paneId && runtime.summary.alive)) {
      throw new Error(`Terminal pane '${input.paneId}' already has a live runtime`);
    }

    const runtime: TerminalRuntimeRecord = {
      ownerPaneId: input.paneId ?? null,
      summary: {
        rootKey,
        rootDir,
        runtimeId,
        cwd,
        alive: true,
        createdAt: now,
        updatedAt: now,
        commandCount: 0
      },
      lines: [
        `flmux terminal proof`,
        `rootDir: ${rootDir}`,
        `cwd: ${cwd}`,
        `type 'help' for built-in commands`,
        prompt(cwd)
      ],
      history: ""
    };

    runtime.history = `${runtime.lines.join("\n")}\n`;
    root.runtimes.set(runtimeId, runtime);
    root.status.runtimeCount = root.runtimes.size;
    root.status.updatedAt = now;
    this.runtimeOwners.set(runtimeId, input.paneId ?? null);
    emit(this.subscribers, { type: "state", paneId: input.paneId ?? null, terminal: cloneSummary(runtime.summary) });

    return {
      ok: true,
      rootKey,
      runtimeId,
      history: runtime.history,
      terminal: cloneSummary(runtime.summary)
    };
  }

  async write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult> {
    const runtime = this.requireRuntime(input.rootKey, input.runtimeId);
    if (!runtime.summary.alive) {
      return {
        ok: true,
        accepted: false,
        runtimeId: input.runtimeId,
        history: runtime.history,
        terminal: null
      };
    }

    const commands = input.data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const command of commands) {
      runtime.summary.commandCount += 1;
      runtime.lines.push(`${prompt(runtime.summary.cwd)} ${command}`);
      runtime.lines.push(...this.runBuiltIn(runtime, command));
    }

    if (runtime.summary.alive) {
      runtime.lines.push(prompt(runtime.summary.cwd));
    }

    runtime.summary.updatedAt = new Date().toISOString();
    runtime.history = `${runtime.lines.join("\n")}\n`;

    const root = this.roots.get(input.rootKey)!;
    root.status.updatedAt = runtime.summary.updatedAt;
    emit(this.subscribers, {
      type: "state",
      paneId: this.runtimeOwners.get(input.runtimeId) ?? null,
      terminal: cloneSummary(runtime.summary)
    });

    return {
      ok: true,
      accepted: commands.length > 0,
      runtimeId: input.runtimeId,
      history: runtime.history,
      terminal: cloneSummary(runtime.summary)
    };
  }

  async resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult> {
    const runtime = this.requireRuntime(input.rootKey, input.runtimeId);
    if (!runtime.summary.alive) {
      return {
        ok: true,
        accepted: false,
        runtimeId: input.runtimeId,
        terminal: null
      };
    }

    runtime.summary.updatedAt = new Date().toISOString();
    const root = this.roots.get(input.rootKey)!;
    root.status.updatedAt = runtime.summary.updatedAt;
    emit(this.subscribers, {
      type: "state",
      paneId: this.runtimeOwners.get(input.runtimeId) ?? null,
      terminal: cloneSummary(runtime.summary)
    });

    return {
      ok: true,
      accepted: true,
      runtimeId: input.runtimeId,
      terminal: cloneSummary(runtime.summary)
    };
  }

  async history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult> {
    const runtime = this.requireRuntime(input.rootKey, input.runtimeId);
    const history =
      input.maxBytes && input.maxBytes > 0
        ? runtime.history.slice(-input.maxBytes)
        : runtime.history;

    return {
      ok: true,
      runtimeId: input.runtimeId,
      data: history
    };
  }

  async kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult> {
    const runtime = this.requireRuntime(input.rootKey, input.runtimeId);
    if (!runtime.summary.alive) {
      return {
        ok: true,
        rootKey: input.rootKey,
        runtimeId: input.runtimeId,
        killed: false,
        terminal: null
      };
    }

    runtime.summary.alive = false;
    runtime.summary.updatedAt = new Date().toISOString();
    runtime.lines.push("[terminal closed]");
    runtime.history = `${runtime.lines.join("\n")}\n`;

    const root = this.roots.get(input.rootKey)!;
    root.status.updatedAt = runtime.summary.updatedAt;
    emit(this.subscribers, {
      type: "removed",
      paneId: this.runtimeOwners.get(input.runtimeId) ?? null,
      runtimeId: input.runtimeId
    });
    this.runtimeOwners.delete(input.runtimeId);

    return {
      ok: true,
      rootKey: input.rootKey,
      runtimeId: input.runtimeId,
      killed: true,
      terminal: cloneSummary(runtime.summary)
    };
  }

  async listRoots(): Promise<TerminalRootStatus[]> {
    return [...this.roots.values()].map((root) => ({ ...root.status }));
  }

  subscribe(handler: (event: TerminalRuntimeEvent) => void) {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  dispose() {
    this.subscribers.clear();
    this.runtimeOwners.clear();
    this.roots.clear();
  }

  private getOrCreateRoot(rootDir: string, rootKey: string): TerminalRootRecord {
    const existing = this.roots.get(rootKey);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const created: TerminalRootRecord = {
      status: {
        rootKey,
        rootDir,
        runtimeCount: 0,
        updatedAt: now
      },
      runtimes: new Map()
    };

    this.roots.set(rootKey, created);
    return created;
  }

  private requireRuntime(rootKey: string, runtimeId: string) {
    const root = this.roots.get(rootKey);
    if (!root) {
      throw new Error(`Unknown terminal root: ${rootKey}`);
    }

    const runtime = root.runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error(`Unknown terminal runtime: ${runtimeId}`);
    }

    return runtime;
  }

  private runBuiltIn(runtime: TerminalRuntimeRecord, command: string) {
    const [name, ...rest] = command.split(/\s+/);
    switch (name) {
      case "help":
        return ["commands: help, pwd, roots, history, date, clear, exit, echo <text>"];

      case "pwd":
        return [runtime.summary.cwd];

      case "roots":
        return [...this.roots.values()].map((root) => `${root.status.rootKey} -> ${root.status.rootDir}`);

      case "history":
        return runtime.lines.filter((line) => line.startsWith(prompt(runtime.summary.cwd)));

      case "date":
        return [new Date().toISOString()];

      case "clear":
        runtime.lines = [];
        return ["[screen cleared]"];

      case "exit":
        runtime.summary.alive = false;
        return ["[terminal closed]"];

      case "echo":
        return [rest.join(" ")];

      default:
        return [`echo: ${command}`];
    }
  }
}

function emit(
  subscribers: Set<(event: TerminalRuntimeEvent) => void>,
  event: TerminalRuntimeEvent
) {
  for (const subscriber of subscribers) {
    subscriber(event);
  }
}

function prompt(cwd: string) {
  return `${cwd}>`;
}

function cloneSummary(summary: TerminalRuntimeSummary): TerminalRuntimeSummary {
  return { ...summary };
}
