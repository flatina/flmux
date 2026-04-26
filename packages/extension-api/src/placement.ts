import type { ShellClient } from "./shell";

export type PanePlacement = "within" | "left" | "right" | "above" | "below";

/**
 * Pack `/panes/new` into columns of at most `maxRowsPerColumn` rows.
 * Counts only panes matching `isTargetKind`.
 *
 *   count = 0                  →  { place: "right" }                       (first split)
 *   count % maxRows === 0      →  { place: "right" }                       (new column — omit referencePaneId so Dockview splits at root)
 *   otherwise                  →  { place: "below", referencePaneId: last }
 *
 * `last` = most-recently-created target. Creation-order proxy, not spatial
 * — after user drags/closes, "last" may no longer live where assumed.
 * Caller should allow explicit `--place` override.
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
  // No encodeURIComponent — shell path parser splits on `/` only, doesn't URL-decode.
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
  if (targets.length % options.maxRowsPerColumn === 0) {
    // Drop referencePaneId — Dockview's root-level split needs `direction` only;
    // a panel-relative ref would split a single row instead of starting a new column.
    return { place: "right" };
  }
  const lastId = targets[targets.length - 1]!;
  return { place: "below", referencePaneId: lastId };
}
