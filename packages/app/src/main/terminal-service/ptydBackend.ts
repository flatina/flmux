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
} from "@flmux/core/terminal/types";
import { PtydClient } from "../ptyd/client";
import type { TerminalBackend } from "@flmux/core/terminal/backend";
import { toTerminalRootKey } from "@flmux/core/terminal/rootKey";
import { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "@flmux/core/terminal/path";

export function createPtydBackend(): TerminalBackend {
  return new PtydBackend();
}

class PtydBackend implements TerminalBackend {
  private readonly clients = new Map<string, PtydClient>();
  private readonly pendingClients = new Map<string, Promise<PtydClient>>();
  private readonly pendingProbes = new Map<string, Promise<TerminalRootStatus | null>>();
  private readonly runtimeOwners = new Map<string, string | null>();
  private readonly subscribers = new Set<(event: TerminalRuntimeEvent) => void>();

  async adoptByPaneId(input: { rootDir: string; paneId: string }): Promise<TerminalAdoptResult> {
    const rootDir = normalizeTerminalRootDir(input.rootDir);
    const client = await this.getClient(rootDir);
    const matches = (await client.list()).filter((runtime) => runtime.ownerPaneId === input.paneId);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.warn(
          `multiple runtimes matched ownerPaneId '${input.paneId}' in root '${matches[0]?.rootKey ?? "unknown"}'`
        );
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
        paneId: input.paneId,
        appOrigin: input.appOrigin
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

  async resize(input: {
    rootKey: string;
    runtimeId: string;
    cols: number;
    rows: number;
  }): Promise<TerminalResizeResult> {
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
    return Promise.all([...this.clients.values()].map((client) => client.getRootStatus()));
  }

  /**
   * Query-only: attach to the daemon for `rootDir` if one is already
   * running, without launching. Returns `null` when no daemon exists
   * for that rootDir. Used by observers/test-harnesses that need to
   * inspect a daemon started by a different backend instance.
   */
  async probeRoot(rootDir: string): Promise<TerminalRootStatus | null> {
    const rootKey = toTerminalRootKey(rootDir);
    const existing = this.clients.get(rootKey);
    if (existing) {
      return existing.getRootStatus();
    }
    const pendingLaunch = this.pendingClients.get(rootKey);
    if (pendingLaunch) {
      return (await pendingLaunch).getRootStatus();
    }
    // Dedupe concurrent probes — stranded event sockets otherwise.
    const pendingProbe = this.pendingProbes.get(rootKey);
    if (pendingProbe) {
      return pendingProbe;
    }

    const next = (async () => {
      // Probe is strictly query-only: create a throwaway client, connect
      // if a daemon is already running, read status, then dispose. Never
      // cache the client — `PtydClient.call` falls back to `ensureStarted`
      // on transport errors, which would silently relaunch a daemon that
      // had been intentionally stopped after a prior successful probe.
      const client = new PtydClient(rootKey, rootDir, (event) => this.handlePtydEvent(event));
      try {
        const connected = await client.connectIfRunning();
        if (!connected) return null;
        return await client.getRootStatus();
      } finally {
        client.dispose();
      }
    })();

    this.pendingProbes.set(rootKey, next);
    try {
      return await next;
    } finally {
      this.pendingProbes.delete(rootKey);
    }
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

  private handlePtydEvent(event: import("@flmux/core/terminal/ptyd/controlPlane").PtydTerminalEvent) {
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
