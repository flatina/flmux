import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FlmuxSessionSnapshot } from "../shared/session";

export interface FlmuxSessionStore {
  load(): Promise<FlmuxSessionSnapshot | null>;
  save(snapshot: FlmuxSessionSnapshot): Promise<void>;
}

export function createSessionStore(): FlmuxSessionStore {
  const filePath = process.env.FLMUX_SESSION_FILE?.trim() || join(process.cwd(), ".tmp", "session.json");

  return {
    async load() {
      try {
        const parsed = await Bun.file(filePath).json();
        return isSessionSnapshot(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(snapshot) {
      await mkdir(dirname(filePath), { recursive: true });
      await Bun.write(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
  };
}

export function isSessionSnapshot(value: unknown): value is FlmuxSessionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 2 ||
    typeof snapshot.appTitle !== "string" ||
    typeof snapshot.activeWorkspaceId !== "string" ||
    !snapshot.workspaces ||
    typeof snapshot.workspaces !== "object"
  ) {
    return false;
  }

  return Object.values(snapshot.workspaces as Record<string, unknown>).every((workspace) => {
    if (!workspace || typeof workspace !== "object") {
      return false;
    }

    const candidate = workspace as Record<string, unknown>;
    return (
      (candidate.defaultTitle === undefined || typeof candidate.defaultTitle === "string") &&
      typeof candidate.title === "string" &&
      "layout" in candidate &&
      (candidate.layout === null || typeof candidate.layout === "object")
    );
  });
}
