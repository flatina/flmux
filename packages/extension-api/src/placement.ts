import type { ShellClient } from "./shell";

export type PanePlacement = "within" | "left" | "right" | "above" | "below";

/**
 * Pack `/panes/new` into a `maxColumns × maxRowsPerColumn` grid, counting only
 * `isTargetKind` panes. Once the grid is full, overflow tabs into cells
 * round-robin by creation order (keeps per-cell tab counts balanced).
 *
 *   n = 0                    →  right                          (first split)
 *   n ≥ maxColumns·maxRows    →  within, ref targets[n % cap]   (overflow tab)
 *   n % maxRows === 0         →  right                          (new column, root split)
 *   otherwise                →  below, ref targets[n-1]
 *
 * Count-based, not spatial: indices are a creation-order proxy, so after the
 * user drags/closes a "cell" may not live where assumed. Caller should allow an
 * explicit `--place` override.
 */
export async function resolveColumnFillPlacement(
  client: ShellClient,
  options: {
    workspaceId: string;
    isTargetKind: (kind: string) => boolean;
    maxRowsPerColumn: number;
    maxColumns: number;
  }
): Promise<{ place: PanePlacement; referencePaneId?: string }> {
  if (!Number.isInteger(options.maxRowsPerColumn) || options.maxRowsPerColumn <= 0) {
    throw new Error("resolveColumnFillPlacement: maxRowsPerColumn must be a positive integer");
  }
  if (!Number.isInteger(options.maxColumns) || options.maxColumns <= 0) {
    throw new Error("resolveColumnFillPlacement: maxColumns must be a positive integer");
  }
  // No encodeURIComponent — shell path parser splits on `/` only, doesn't URL-decode.
  const result = await client.get(`/status/workspaces/${options.workspaceId}/panes`);
  if (!result.ok) {
    throw new Error(`resolveColumnFillPlacement: ${result.code} ${result.error}`);
  }
  if (!result.found || typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
    throw new Error(`resolveColumnFillPlacement: workspace '${options.workspaceId}' not found`);
  }
  const targets: string[] = [];
  for (const [paneId, snapshot] of Object.entries(result.value as Record<string, { kind?: unknown }>)) {
    const kind = snapshot?.kind;
    if (typeof kind === "string" && options.isTargetKind(kind)) {
      targets.push(paneId);
    }
  }
  const n = targets.length;
  if (n === 0) {
    return { place: "right" };
  }
  const cap = options.maxRowsPerColumn * options.maxColumns;
  if (n >= cap) {
    // Grid full → tab into a cell, round-robin by creation order so per-cell
    // tab counts stay balanced. `n % cap` indexes the original cell occupants
    // (targets[0..cap-1]); equals the proposed `(n - cap) % cap` since cap ≡ 0.
    return { place: "within", referencePaneId: targets[n % cap]! };
  }
  if (n % options.maxRowsPerColumn === 0) {
    // New column (n < cap ⇒ column index < maxColumns). Drop referencePaneId —
    // Dockview's root-level split needs `direction` only; a panel-relative ref
    // would split a single row instead of starting a new column.
    return { place: "right" };
  }
  return { place: "below", referencePaneId: targets[n - 1]! };
}
