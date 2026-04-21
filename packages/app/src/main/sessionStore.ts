import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { FlmuxSessionSnapshot } from "../shared/session";

export interface FlmuxSessionStore {
  load(): Promise<FlmuxSessionSnapshot | null>;
  save(snapshot: FlmuxSessionSnapshot): Promise<void>;
}

export interface FlmuxSessionStoreOptions {
  /** Absolute path to the session snapshot file. Required. Desktop
   * passes `<flmuxDir>/session.json`; web-mode passes
   * `<authDir>/sessions/<userId>/session.json`. */
  filePath: string;
}

export function createSessionStore(options: FlmuxSessionStoreOptions): FlmuxSessionStore {
  const { filePath } = options;

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
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await Bun.write(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(tmpPath, filePath);
    }
  };
}

export function isSessionSnapshot(value: unknown): value is FlmuxSessionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 4 ||
    typeof snapshot.appTitle !== "string" ||
    !("outerLayout" in snapshot) ||
    !isPlainObjectOrNull(snapshot.outerLayout) ||
    !isPlainObject(snapshot.workspaces)
  ) {
    return false;
  }

  return Object.values(snapshot.workspaces as Record<string, unknown>).every((workspace) => {
    if (!isPlainObject(workspace)) {
      return false;
    }

    const candidate = workspace as Record<string, unknown>;
    return (
      (candidate.defaultTitle === undefined || typeof candidate.defaultTitle === "string") &&
      typeof candidate.title === "string" &&
      "innerLayout" in candidate &&
      isPlainObjectOrNull(candidate.innerLayout)
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObjectOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || isPlainObject(value);
}
