import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, isSessionSnapshot } from "../src/main/sessionStore";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.FLMUX_SESSION_FILE;
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("session store", () => {
  it("accepts only version 2 session snapshots", () => {
    expect(isSessionSnapshot({
      version: 2,
      appTitle: "flmux",
      activeWorkspaceId: "workspace.alpha",
      workspaces: {
        "workspace.alpha": {
          title: "Workspace Alpha",
          layout: null
        }
      }
    })).toBe(true);

    expect(isSessionSnapshot({
      version: 1,
      appTitle: "flmux",
      activeWorkspaceId: "workspace.alpha",
      workspaces: {
        "workspace.alpha": {
          title: "Workspace Alpha",
          layout: null
        }
      }
    })).toBe(false);
  });

  it("ignores persisted v1 snapshots on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flmux-session-store-"));
    tempDirs.push(dir);
    const sessionFile = join(dir, "session.json");
    process.env.FLMUX_SESSION_FILE = sessionFile;

    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      appTitle: "legacy flmux",
      activeWorkspaceId: "workspace.alpha",
      workspaces: {
        "workspace.alpha": {
          title: "Legacy Workspace",
          layout: null
        }
      }
    }, null, 2), "utf8");

    const store = createSessionStore();
    expect(await store.load()).toBeNull();
  });
});
