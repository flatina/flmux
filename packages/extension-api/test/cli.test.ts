import { describe, expect, it } from "bun:test";
import { resolveColumnFillPlacement } from "../src/cli";
import { createTestShellClient } from "../src/testing";

function makeClient(panes: Record<string, { kind: string }>) {
  return createTestShellClient({
    "get /status/workspaces/ws.1/panes": () => panes
  });
}

describe("resolveColumnFillPlacement", () => {
  const isPlot = (kind: string) => kind.startsWith("plot.");

  it("returns place=right with no reference when no target panes exist yet", async () => {
    const client = makeClient({
      "pane.term": { kind: "terminal" }
    });
    const placement = await resolveColumnFillPlacement(client, {
      workspaceId: "ws.1",
      isTargetKind: isPlot,
      maxRowsPerColumn: 4
    });
    expect(placement).toEqual({ place: "right" });
  });

  it("extends the current column when the rightmost column isn't full", async () => {
    const client = makeClient({
      "pane.term": { kind: "terminal" },
      "pane.plot.1": { kind: "plot.trend" },
      "pane.plot.2": { kind: "plot.spectrum" }
    });
    const placement = await resolveColumnFillPlacement(client, {
      workspaceId: "ws.1",
      isTargetKind: isPlot,
      maxRowsPerColumn: 4
    });
    expect(placement).toEqual({ place: "below", referencePaneId: "pane.plot.2" });
  });

  it("starts a new column once the rightmost column hits maxRowsPerColumn", async () => {
    const client = makeClient({
      "pane.term": { kind: "terminal" },
      "pane.plot.1": { kind: "plot.trend" },
      "pane.plot.2": { kind: "plot.trend" },
      "pane.plot.3": { kind: "plot.trend" },
      "pane.plot.4": { kind: "plot.trend" }
    });
    const placement = await resolveColumnFillPlacement(client, {
      workspaceId: "ws.1",
      isTargetKind: isPlot,
      maxRowsPerColumn: 4
    });
    expect(placement).toEqual({ place: "right", referencePaneId: "pane.plot.4" });
  });

  it("ignores panes that don't match isTargetKind when counting", async () => {
    // Two plots already, plus a browser pane mixed in: count is 2 (plots), not 3.
    const client = makeClient({
      "pane.term": { kind: "terminal" },
      "pane.plot.1": { kind: "plot.trend" },
      "pane.browser": { kind: "browser" },
      "pane.plot.2": { kind: "plot.trend" }
    });
    const placement = await resolveColumnFillPlacement(client, {
      workspaceId: "ws.1",
      isTargetKind: isPlot,
      maxRowsPerColumn: 4
    });
    expect(placement).toEqual({ place: "below", referencePaneId: "pane.plot.2" });
  });

  it("respects maxRowsPerColumn for non-default values", async () => {
    // maxRows=2: third plot starts a new column.
    const after2 = await resolveColumnFillPlacement(
      makeClient({
        "pane.plot.1": { kind: "plot.trend" },
        "pane.plot.2": { kind: "plot.trend" }
      }),
      { workspaceId: "ws.1", isTargetKind: isPlot, maxRowsPerColumn: 2 }
    );
    expect(after2).toEqual({ place: "right", referencePaneId: "pane.plot.2" });

    const after1 = await resolveColumnFillPlacement(
      makeClient({ "pane.plot.1": { kind: "plot.trend" } }),
      { workspaceId: "ws.1", isTargetKind: isPlot, maxRowsPerColumn: 2 }
    );
    expect(after1).toEqual({ place: "below", referencePaneId: "pane.plot.1" });
  });

  it("rejects invalid maxRowsPerColumn values up front", async () => {
    const client = makeClient({});
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        resolveColumnFillPlacement(client, {
          workspaceId: "ws.1",
          isTargetKind: isPlot,
          maxRowsPerColumn: bad
        })
      ).rejects.toThrow("maxRowsPerColumn must be a positive integer");
    }
  });

  it("throws when the workspace can't be resolved", async () => {
    // No matching route → testShellClient returns {ok:false, code:NOT_FOUND}
    const client = createTestShellClient({});
    await expect(
      resolveColumnFillPlacement(client, {
        workspaceId: "ws.missing",
        isTargetKind: isPlot,
        maxRowsPerColumn: 4
      })
    ).rejects.toThrow("NOT_FOUND");
  });
});
