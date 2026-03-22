import { describe, expect, test } from "bun:test";
import {
  getAppRpcIpcPath,
  getPtydControlIpcPath,
  getPtydEventsIpcPath,
  getWorkspaceKey,
  normalizeWorkspaceRoot
} from "./ipc-paths";

describe("normalizeWorkspaceRoot", () => {
  test("normalizes backslashes to forward slashes", () => {
    expect(normalizeWorkspaceRoot("C:\\foo\\bar")).toMatch(/c:\/foo\/bar|C:\/foo\/bar/);
  });

  test("is deterministic", () => {
    expect(normalizeWorkspaceRoot("C:\\foo")).toBe(normalizeWorkspaceRoot("C:\\foo"));
  });
});

describe("getWorkspaceKey", () => {
  test("returns a 16-char hex string", () => {
    const key = getWorkspaceKey("/tmp/workspace");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic", () => {
    expect(getWorkspaceKey("/tmp/ws")).toBe(getWorkspaceKey("/tmp/ws"));
  });

  test("different roots produce different keys", () => {
    expect(getWorkspaceKey("/tmp/a")).not.toBe(getWorkspaceKey("/tmp/b"));
  });
});

describe("IPC paths", () => {
  const root = "/tmp/test-workspace";

  test("app RPC path contains workspace key", () => {
    const key = getWorkspaceKey(root);
    expect(getAppRpcIpcPath(root)).toContain(key);
  });

  test("ptyd control and events paths are distinct", () => {
    expect(getPtydControlIpcPath(root)).not.toBe(getPtydEventsIpcPath(root));
  });

  test("ptyd paths contain workspace key", () => {
    const key = getWorkspaceKey(root);
    expect(getPtydControlIpcPath(root)).toContain(key);
    expect(getPtydEventsIpcPath(root)).toContain(key);
  });
});
