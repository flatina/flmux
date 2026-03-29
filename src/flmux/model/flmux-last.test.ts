import { describe, expect, test } from "bun:test";
import { createFlmuxLastFile } from "./flmux-last";

describe("createFlmuxLastFile", () => {
  test("sets schemaVersion to 2", () => {
    const file = createFlmuxLastFile({ activePaneId: null, workspaceLayout: null });
    expect(file.schemaVersion).toBe(2);
  });

  test("includes savedAt timestamp", () => {
    const file = createFlmuxLastFile({ activePaneId: null, workspaceLayout: null });
    expect(file.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
