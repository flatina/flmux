import type { ShellClient } from "./shell";

// DOM-free: only depends on `./shell` so `@flmux/extension-api/cli`
// (CLI-only consumers without DOM lib) and `@flmux/extension-api` main
// (renderer + server entries) can both surface this without dragging in
// the `HTMLElement` declarations from `./pane`.
export type PanePlacement = "within" | "left" | "right" | "above" | "below";

/**
 * Compute a `/panes/new` placement that packs new panes into columns of
 * at most `maxRowsPerColumn` rows. Inspects the current workspace via
 * `client.get("/status/workspaces/<id>/panes")`; counts only panes whose
 * `kind` matches `isTargetKind` (other kinds — terminal, browser — are
 * ignored). Heuristic:
 *
 *   target count = 0           →  { place: "right" }                       (1st split)
 *   count % maxRows === 0      →  { place: "right",  referencePaneId: last } (new column)
 *   otherwise                  →  { place: "below",  referencePaneId: last } (extend column)
 *
 * `last` = the most recently created matching pane. The "rightmost column"
 * intuition is a *creation-order proxy*, not a spatial guarantee — after
 * the user drags or closes panes, the most recently created target may no
 * longer live in the rightmost column, and the next placement extends the
 * wrong one. Caller should always allow an explicit `--place` override.
 *
 * Concurrency: not lock-protected. Two callers racing on the same
 * workspace can both observe the same count and pick the same placement.
 * Acceptable for the human + agent workflow this is intended for; mutual
 * exclusion would have to come from the caller.
 *
 * Pane-ID assumption: relies on `Object.entries` preserving insertion
 * order on the panes map, which JS only guarantees for non-integer-like
 * keys. flmux's pane IDs (`pane_<uuid>`, `pane.<…>`) satisfy this; if a
 * future authority emits all-digit ids, the "last" picked here would be
 * wrong.
 */
export async function resolveColumnFillPlacement(
  client: ShellClient,
  options: {
    workspaceId: string;
    isTargetKind: (kind: string) => boolean;
    maxRowsPerColumn: number;
  }
): Promise<{ place: PanePlacement; referencePaneId?: string }> {
  if (!Number.isInteger(options.maxRowsPerColumn) || options.maxRowsPerColumn <= 0) {
    throw new Error("resolveColumnFillPlacement: maxRowsPerColumn must be a positive integer");
  }
  // No encodeURIComponent — the shell path parser splits on `/` only and
  // doesn't URL-decode segments, so encoding `%20` etc. would hit NOT_FOUND
  // for workspace ids the model otherwise resolves verbatim.
  const result = await client.get(`/status/workspaces/${options.workspaceId}/panes`);
  if (!result.ok) {
    throw new Error(`resolveColumnFillPlacement: ${result.code} ${result.error}`);
  }
  if (
    !result.found ||
    typeof result.value !== "object" ||
    result.value === null ||
    Array.isArray(result.value)
  ) {
    throw new Error(`resolveColumnFillPlacement: workspace '${options.workspaceId}' not found`);
  }
  const targets: string[] = [];
  for (const [paneId, snapshot] of Object.entries(result.value as Record<string, { kind?: unknown }>)) {
    const kind = snapshot?.kind;
    if (typeof kind === "string" && options.isTargetKind(kind)) {
      targets.push(paneId);
    }
  }
  if (targets.length === 0) {
    return { place: "right" };
  }
  const lastId = targets[targets.length - 1]!;
  if (targets.length % options.maxRowsPerColumn === 0) {
    return { place: "right", referencePaneId: lastId };
  }
  return { place: "below", referencePaneId: lastId };
}
