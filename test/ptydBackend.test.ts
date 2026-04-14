import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createPtydBackend } from "../src/main/terminal-service/ptydBackend";
import { stopOwnedPtydDaemonsForRootDir } from "./support/ptydCleanup";
import { waitFor } from "./support/waitFor";

describe("ptyd backend", () => {
  it(
    "spawns a daemon, exposes runtime state, and preserves pane ownership on events",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "flmux-ptyd-backend-"));
      const backend = createPtydBackend();
      const observerBackend = createPtydBackend();
      const events: Array<{ type: string; paneId?: string | null; runtimeId?: string; data?: string }> = [];
      const unsubscribe = backend.subscribe((event) => {
        if (event.type === "state") {
          events.push({ type: event.type, paneId: event.paneId, runtimeId: event.terminal.runtimeId });
          return;
        }

        events.push({
          type: event.type,
          paneId: event.paneId,
          runtimeId: event.runtimeId,
          data: "data" in event ? event.data : undefined
        });
      });

      try {
        const created = await backend.create({
          paneId: "pane.term",
          rootDir,
          cwd: "."
        });
        expect(created.ok).toBe(true);
        expect(created.terminal.rootDir).toBe(rootDir);

        const discoveredRoots = await waitFor(async () => {
          const roots = await observerBackend.listRoots();
          return roots.find((root) => root.rootKey === created.rootKey) ?? null;
        }, { timeoutMs: 15_000, intervalMs: 250, label: "observer root discovery" });
        expect(discoveredRoots).toMatchObject({
          rootKey: created.rootKey,
          rootDir,
          runtimeCount: 1
        });

        const marker = `flmux-ptyd-${crypto.randomUUID()}`;
        const wrote = await backend.write({
          rootKey: created.rootKey,
          runtimeId: created.runtimeId,
          data: `echo ${marker}\r`
        });
        expect(wrote).toMatchObject({
          ok: true,
          accepted: true,
          runtimeId: created.runtimeId
        });

        const history = await waitFor(async () => {
          const next = await backend.history({
            rootKey: created.rootKey,
            runtimeId: created.runtimeId,
            maxBytes: 20_000
          });
          return next.data.includes(marker) ? next : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "ptyd history marker" });
        expect(history.data).toContain(marker);

        await waitFor(async () => {
          return events.some((event) => event.type === "output" && event.paneId === "pane.term")
            ? true
            : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "ptyd output event" });

        const killed = await backend.kill({
          rootKey: created.rootKey,
          runtimeId: created.runtimeId
        });
        expect(killed).toMatchObject({
          ok: true,
          rootKey: created.rootKey,
          runtimeId: created.runtimeId,
          killed: true
        });

        await waitFor(async () => {
          return events.some((event) => event.type === "removed" && event.paneId === "pane.term")
            ? true
            : null;
        }, { timeoutMs: 15_000, intervalMs: 250, label: "ptyd removed event" });

        const rootsAfterKill = await waitFor(async () => {
          const roots = await observerBackend.listRoots();
          const root = roots.find((candidate) => candidate.rootKey === created.rootKey);
          return root && root.runtimeCount === 0 ? root : null;
        }, { timeoutMs: 15_000, intervalMs: 250, label: "ptyd runtime count after kill" });
        expect(rootsAfterKill.runtimeCount).toBe(0);
      } finally {
        unsubscribe();
        await stopOwnedPtydDaemonsForRootDir(rootDir);
        observerBackend.dispose?.();
        backend.dispose?.();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    45_000
  );

  it(
    "adopts a surviving runtime by pane id after backend restart",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "flmux-ptyd-adopt-"));
      const backend = createPtydBackend();
      try {
        const created = await backend.create({
          paneId: "pane.term",
          rootDir,
          cwd: "."
        });

        await expect(backend.create({
          paneId: "pane.term",
          rootDir,
          cwd: "."
        })).rejects.toThrow("already has a live runtime");

        const marker = `flmux-adopt-${crypto.randomUUID()}`;
        await backend.write({
          rootKey: created.rootKey,
          runtimeId: created.runtimeId,
          data: `echo ${marker}\r`
        });
        await waitFor(async () => {
          const history = await backend.history({
            rootKey: created.rootKey,
            runtimeId: created.runtimeId,
            maxBytes: 20_000
          });
          return history.data.includes(marker) ? true : null;
        }, { timeoutMs: 20_000, intervalMs: 250, label: "pre-adopt history marker" });

        backend.dispose?.();

        const adoptedBackend = createPtydBackend();
        const events: Array<{ type: string; paneId?: string | null; data?: string }> = [];
        const unsubscribe = adoptedBackend.subscribe((event) => {
          events.push({
            type: event.type,
            paneId: event.paneId ?? null,
            data: "data" in event ? event.data : undefined
          });
        });

        try {
          const adopted = await adoptedBackend.adoptByPaneId({
            rootDir,
            paneId: "pane.term"
          });
          expect(adopted).toMatchObject({
            ok: true,
            outcome: "adopted",
            rootKey: created.rootKey,
            runtimeId: created.runtimeId,
            terminal: {
              runtimeId: created.runtimeId
            }
          });
          if (adopted.outcome !== "adopted") {
            throw new Error("expected adopted runtime");
          }
          expect(adopted.history).toContain(marker);

          const secondMarker = `flmux-adopt-next-${crypto.randomUUID()}`;
          await adoptedBackend.write({
            rootKey: adopted.rootKey,
            runtimeId: adopted.runtimeId,
            data: `echo ${secondMarker}\r`
          });

          await waitFor(async () => {
            return events.some((event) => event.type === "output" && event.paneId === "pane.term" && event.data?.includes(secondMarker))
              ? true
              : null;
          }, { timeoutMs: 20_000, intervalMs: 250, label: "post-adopt output event" });

          const adoptedHistory = await waitFor(async () => {
            const history = await adoptedBackend.history({
              rootKey: adopted.rootKey,
              runtimeId: adopted.runtimeId,
              maxBytes: 20_000
            });
            return history.data.includes(secondMarker) ? history : null;
          }, { timeoutMs: 20_000, intervalMs: 250, label: "post-adopt history marker" });
          expect(adoptedHistory.data).toContain(marker);
          expect(adoptedHistory.data).toContain(secondMarker);

          expect(await adoptedBackend.adoptByPaneId({
            rootDir,
            paneId: "pane.missing"
          })).toEqual({
            ok: true,
            outcome: "not_found"
          });
        } finally {
          unsubscribe();
          adoptedBackend.dispose?.();
        }
      } finally {
        await stopOwnedPtydDaemonsForRootDir(rootDir);
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    45_000
  );

  it(
    "adopts a closed runtime by pane id and preserves its final history",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "flmux-ptyd-closed-adopt-"));
      const backend = createPtydBackend();
      try {
        const created = await backend.create({
          paneId: "pane.term",
          rootDir,
          cwd: "."
        });

        await backend.write({
          rootKey: created.rootKey,
          runtimeId: created.runtimeId,
          data: "exit\r"
        });

        const observerBackend = createPtydBackend();
        try {
          await waitFor(async () => {
            const adopted = await observerBackend.adoptByPaneId({
              rootDir,
              paneId: "pane.term"
            });
            return adopted.outcome === "adopted" && adopted.terminal.alive === false ? adopted : null;
          }, { timeoutMs: 20_000, intervalMs: 250, label: "closed terminal runtime" });
        } finally {
          observerBackend.dispose?.();
        }

        backend.dispose?.();

        const adoptedBackend = createPtydBackend();
        try {
          const adopted = await adoptedBackend.adoptByPaneId({
            rootDir,
            paneId: "pane.term"
          });
          expect(adopted).toMatchObject({
            ok: true,
            outcome: "adopted",
            rootKey: created.rootKey,
            runtimeId: created.runtimeId,
            terminal: {
              runtimeId: created.runtimeId,
              alive: false
            }
          });
          if (adopted.outcome !== "adopted") {
            throw new Error("expected adopted runtime");
          }

          expect(adopted.history).toContain("exit");
          const writeResult = await adoptedBackend.write({
            rootKey: adopted.rootKey,
            runtimeId: adopted.runtimeId,
            data: "echo after-close\r"
          });
          expect(writeResult).toMatchObject({
            ok: true,
            accepted: false,
            runtimeId: adopted.runtimeId,
            terminal: null
          });
        } finally {
          adoptedBackend.dispose?.();
        }
      } finally {
        await stopOwnedPtydDaemonsForRootDir(rootDir);
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    45_000
  );
});
