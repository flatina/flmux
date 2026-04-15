import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  TerminalWriteResult
} from "../../shared/terminal";
import { PtydClient } from "../ptyd/client";
import type { TerminalBackend } from "./backend";
import { toTerminalRootKey } from "./rootKey";
import { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "../../shared/terminalPath";

export function createPtydBackend(): TerminalBackend {
  return new PtydBackend();
}

class PtydBackend implements TerminalBackend {
  private readonly clients = new Map<string, PtydClient>();
  private readonly pendingClients = new Map<string, Promise<PtydClient>>();
  private readonly runtimeOwners = new Map<string, string | null>();
  private readonly subscribers = new Set<(event: TerminalRuntimeEvent) => void>();

  async adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult> {
    const rootDir = normalizeTerminalRootDir(input.rootDir);
    const client = await this.getClient(rootDir);
    const matches = (await client.list()).filter((runtime) => runtime.ownerPaneId === input.paneId);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.warn(`multiple runtimes matched ownerPaneId '${input.paneId}' in root '${matches[0]?.rootKey ?? "unknown"}'`);
      }
      return {
        ok: true,
        outcome: "not_found"
      };
    }

    const runtime = matches[0];
    this.runtimeOwners.set(runtime.runtimeId, input.paneId);
    const history = await client.history({
      runtimeId: runtime.runtimeId
    });

    return {
      ok: true,
      outcome: "adopted",
      rootKey: runtime.rootKey,
      runtimeId: runtime.runtimeId,
      history: history.data,
      terminal: {
        rootKey: runtime.rootKey,
        rootDir: runtime.rootDir,
        runtimeId: runtime.runtimeId,
        cwd: runtime.cwd,
        alive: runtime.alive,
        createdAt: runtime.createdAt,
        updatedAt: runtime.updatedAt,
        commandCount: runtime.commandCount
      }
    };
  }

  async create(input: TerminalCreateInput): Promise<TerminalCreateResult> {
    const rootDir = normalizeTerminalRootDir(input.rootDir);
    const cwd = resolveTerminalCwdFromRoot(rootDir, input.cwd);
    await mkdir(cwd, { recursive: true });
    const client = await this.getClient(rootDir);
    const runtimeId = `term_${crypto.randomUUID()}`;
    this.runtimeOwners.set(runtimeId, input.paneId ?? null);

    try {
      return await client.createTerminal({
        runtimeId,
        rootDir,
        cwd,
        paneId: input.paneId
      });
    } catch (error) {
      this.runtimeOwners.delete(runtimeId);
      throw error;
    }
  }

  async write(input: { rootKey: string; runtimeId: string; data: string }): Promise<TerminalWriteResult> {
    const client = this.requireClient(input.rootKey);
    return client.input({
      runtimeId: input.runtimeId,
      data: input.data
    });
  }

  async resize(input: { rootKey: string; runtimeId: string; cols: number; rows: number }): Promise<TerminalResizeResult> {
    const client = this.requireClient(input.rootKey);
    return client.resize({
      runtimeId: input.runtimeId,
      cols: input.cols,
      rows: input.rows
    });
  }

  async history(input: { rootKey: string; runtimeId: string; maxBytes?: number }): Promise<TerminalHistoryResult> {
    const client = this.requireClient(input.rootKey);
    return client.history({
      runtimeId: input.runtimeId,
      maxBytes: input.maxBytes
    });
  }

  async kill(input: { rootKey: string; runtimeId: string }): Promise<TerminalKillResult> {
    const client = this.requireClient(input.rootKey);
    const result = await client.killTerminal({
      runtimeId: input.runtimeId
    });
    this.runtimeOwners.delete(input.runtimeId);
    return result;
  }

  async listRoots(): Promise<TerminalRootStatus[]> {
    await this.discoverExistingClients();
    return Promise.all(
      [...this.clients.values()].map((client) => client.getRootStatus())
    );
  }

  subscribe(handler: (event: TerminalRuntimeEvent) => void) {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  dispose() {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.pendingClients.clear();
    this.runtimeOwners.clear();
    this.subscribers.clear();
  }

  private async getClient(rootDir: string) {
    const rootKey = toTerminalRootKey(rootDir);
    const existing = this.clients.get(rootKey);
    if (existing) {
      await existing.ensureStarted();
      return existing;
    }

    const pending = this.pendingClients.get(rootKey);
    if (pending) {
      return pending;
    }

    const next = (async () => {
      const created = new PtydClient(rootKey, rootDir, (event) => this.handlePtydEvent(event));
      await created.ensureStarted();
      this.clients.set(rootKey, created);
      return created;
    })();

    this.pendingClients.set(rootKey, next);
    try {
      return await next;
    } finally {
      this.pendingClients.delete(rootKey);
    }
  }

  private requireClient(rootKey: string) {
    const client = this.clients.get(rootKey);
    if (!client) {
      throw new Error(`No terminal runtime registered for root ${rootKey}`);
    }

    return client;
  }

  private async discoverExistingClients() {
    const directory = tmpdir();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("flmux-ptyd-root_") || !entry.name.endsWith(".lock")) {
        continue;
      }

      const rootKey = entry.name.slice("flmux-ptyd-".length, -".lock".length);
      if (this.clients.has(rootKey) || this.pendingClients.has(rootKey)) {
        continue;
      }

      try {
        const raw = await Bun.file(join(directory, entry.name)).text();
        const lock = JSON.parse(raw) as { rootDir?: string };
        if (typeof lock.rootDir !== "string") {
          continue;
        }

        const client = new PtydClient(rootKey, lock.rootDir, (event) => this.handlePtydEvent(event));
        await client.ensureStarted();
        this.clients.set(rootKey, client);
      } catch {}
    }
  }

  private handlePtydEvent(event: import("../ptyd/controlPlane").PtydTerminalEvent) {
    const paneId =
      event.type === "state"
        ? (this.runtimeOwners.get(event.terminal.runtimeId) ?? null)
        : (this.runtimeOwners.get(event.runtimeId) ?? null);

    if (event.type === "removed") {
      this.runtimeOwners.delete(event.runtimeId);
    }

    const bridged: TerminalRuntimeEvent =
      event.type === "state"
        ? { type: "state", paneId, terminal: event.terminal }
        : event.type === "output"
          ? { type: "output", paneId, runtimeId: event.runtimeId, data: event.data }
          : { type: "removed", paneId, runtimeId: event.runtimeId };

    for (const subscriber of this.subscribers) {
      subscriber(bridged);
    }
  }
}
