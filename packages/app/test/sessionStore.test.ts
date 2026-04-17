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
  it("accepts only version 4 session snapshots", () => {
    expect(isSessionSnapshot({
      version: 4,
      appTitle: "flmux",
      outerLayout: null,
      workspaces: {
        "workspace.alpha": {
          defaultTitle: "Workspace Alpha",
          title: "Workspace Alpha",
          innerLayout: null
        }
      }
    })).toBe(true);

    expect(isSessionSnapshot({
      version: 3,
      appTitle: "flmux",
      workspaces: {
        "workspace.alpha": {
          title: "Workspace Alpha",
          innerLayout: null
        }
      }
    })).toBe(false);
  });

  it("ignores persisted pre-v4 snapshots on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flmux-session-store-"));
    tempDirs.push(dir);
    const sessionFile = join(dir, "session.json");
    process.env.FLMUX_SESSION_FILE = sessionFile;

    await writeFile(sessionFile, JSON.stringify({
      version: 3,
      appTitle: "legacy flmux",
      workspaces: {
        "workspace.alpha": {
          title: "Legacy Workspace",
          innerLayout: null
        }
      }
    }, null, 2), "utf8");

    const store = createSessionStore();
    expect(await store.load()).toBeNull();
  });
});
