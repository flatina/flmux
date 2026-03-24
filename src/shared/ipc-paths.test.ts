import { describe, expect, test } from "bun:test";
import { getAppRpcIpcPath, getPtydControlIpcPath, getPtydEventsIpcPath } from "./ipc-paths";

describe("IPC paths", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";

  test("app RPC path contains session id", () => {
    expect(getAppRpcIpcPath(sessionId)).toContain(sessionId);
  });

  test("ptyd control and events paths are distinct", () => {
    expect(getPtydControlIpcPath(sessionId)).not.toBe(getPtydEventsIpcPath(sessionId));
  });

  test("ptyd paths contain session id", () => {
    expect(getPtydControlIpcPath(sessionId)).toContain(sessionId);
    expect(getPtydEventsIpcPath(sessionId)).toContain(sessionId);
  });
});
