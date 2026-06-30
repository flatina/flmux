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
      maxRowsPerColumn: 4,
      maxColumns: 4
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
      maxRowsPerColumn: 4,
      maxColumns: 4
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
      maxRowsPerColumn: 4,
      maxColumns: 4
    });
    // No referencePaneId — the workbench reads that as Dockview's
    // absolute root-level split, which is what produces a fresh column.
    // A panel-relative reference would split only the bottom row's group.
    expect(placement).toEqual({ place: "right" });
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
      maxRowsPerColumn: 4,
      maxColumns: 4
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
      { workspaceId: "ws.1", isTargetKind: isPlot, maxRowsPerColumn: 2, maxColumns: 4 }
    );
    expect(after2).toEqual({ place: "right" });

    const after1 = await resolveColumnFillPlacement(makeClient({ "pane.plot.1": { kind: "plot.trend" } }), {
      workspaceId: "ws.1",
      isTargetKind: isPlot,
      maxRowsPerColumn: 2,
      maxColumns: 4
    });
    expect(after1).toEqual({ place: "below", referencePaneId: "pane.plot.1" });
  });

  it("treats maxRowsPerColumn=1 as 'every pane is its own column'", async () => {
    // count=1 → 1%1==0 → new column. count=2 → same. So once any plot
    // exists, the next plot always starts a new column off the latest.
    expect(
      await resolveColumnFillPlacement(makeClient({ "pane.plot.1": { kind: "plot.trend" } }), {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 1,
        maxColumns: 4
      })
    ).toEqual({ place: "right" });

    expect(
      await resolveColumnFillPlacement(
        makeClient({
          "pane.plot.1": { kind: "plot.trend" },
          "pane.plot.2": { kind: "plot.trend" }
        }),
        { workspaceId: "ws.1", isTargetKind: isPlot, maxRowsPerColumn: 1, maxColumns: 4 }
      )
    ).toEqual({ place: "right" });
  });

  it("fills the last cell with `below` before the grid is full", async () => {
    // maxRows=2, maxCols=2 → cap=4. n=3 (3 plots) is still below cap: 3%2=1 →
    // extend the second column, NOT overflow.
    const client = makeClient({
      "pane.plot.1": { kind: "plot.trend" },
      "pane.plot.2": { kind: "plot.trend" },
      "pane.plot.3": { kind: "plot.trend" }
    });
    expect(
      await resolveColumnFillPlacement(client, {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 2,
        maxColumns: 2
      })
    ).toEqual({ place: "below", referencePaneId: "pane.plot.3" });
  });

  it("overflows into round-robin tabs once the grid is full", async () => {
    // maxRows=2, maxCols=2 → cap=4. Past cap, tab into cell targets[n % cap]
    // in creation order, so overflow spreads evenly across the 4 cells.
    const plots = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`pane.plot.${i + 1}`, { kind: "plot.trend" }]));
    const resolve = (count: number) =>
      resolveColumnFillPlacement(makeClient(plots(count)), {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 2,
        maxColumns: 2
      });

    expect(await resolve(4)).toEqual({ place: "within", referencePaneId: "pane.plot.1" }); // n=4 → 0
    expect(await resolve(5)).toEqual({ place: "within", referencePaneId: "pane.plot.2" }); // n=5 → 1
    expect(await resolve(7)).toEqual({ place: "within", referencePaneId: "pane.plot.4" }); // n=7 → 3
    expect(await resolve(8)).toEqual({ place: "within", referencePaneId: "pane.plot.1" }); // n=8 → 0 (wrap)
  });

  it("overflows a full single column (maxColumns=1) instead of starting a phantom column", async () => {
    // cap=1*2=2. The n>=cap check must precede n%maxRows===0 — otherwise a full
    // single column (n=2, 2%2===0) would wrongly emit `right` and split a 2nd column.
    const client = makeClient({
      "pane.plot.1": { kind: "plot.trend" },
      "pane.plot.2": { kind: "plot.trend" }
    });
    expect(
      await resolveColumnFillPlacement(client, {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 2,
        maxColumns: 1
      })
    ).toEqual({ place: "within", referencePaneId: "pane.plot.1" });
  });

  it("overflows with maxRowsPerColumn=1 (cap = maxColumns)", async () => {
    // maxRows=1, maxCols=1 → cap=1. n=1 → overflow into the single cell.
    expect(
      await resolveColumnFillPlacement(makeClient({ "pane.plot.1": { kind: "plot.trend" } }), {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 1,
        maxColumns: 1
      })
    ).toEqual({ place: "within", referencePaneId: "pane.plot.1" });
  });

  it("rejects an array payload — guards against a future shape change in the route", async () => {
    const client = createTestShellClient({
      "get /status/workspaces/ws.1/panes": () => [{ kind: "plot.trend" }]
    });
    await expect(
      resolveColumnFillPlacement(client, {
        workspaceId: "ws.1",
        isTargetKind: isPlot,
        maxRowsPerColumn: 4,
        maxColumns: 4
      })
    ).rejects.toThrow("not found");
  });

  it("rejects invalid maxRowsPerColumn values up front", async () => {
    const client = makeClient({});
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        resolveColumnFillPlacement(client, {
          workspaceId: "ws.1",
          isTargetKind: isPlot,
          maxRowsPerColumn: bad,
          maxColumns: 4
        })
      ).rejects.toThrow("maxRowsPerColumn must be a positive integer");
    }
  });

  it("rejects invalid maxColumns values up front", async () => {
    const client = makeClient({});
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        resolveColumnFillPlacement(client, {
          workspaceId: "ws.1",
          isTargetKind: isPlot,
          maxRowsPerColumn: 4,
          maxColumns: bad
        })
      ).rejects.toThrow("maxColumns must be a positive integer");
    }
  });

  it("throws when the workspace can't be resolved", async () => {
    // No matching route → testShellClient returns {ok:false, code:NOT_FOUND}
    const client = createTestShellClient({});
    await expect(
      resolveColumnFillPlacement(client, {
        workspaceId: "ws.missing",
        isTargetKind: isPlot,
        maxRowsPerColumn: 4,
        maxColumns: 4
      })
    ).rejects.toThrow("NOT_FOUND");
  });
});
