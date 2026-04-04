import { defineCommand } from "citty";
import { asPaneId } from "../../../lib/ids";
import { isTerminalRenderer } from "../../model/pane-params";
import type { PaneCreateDirection, PaneCreateInput } from "../../../types/pane";
import type { PaneSourceInfo } from "../../model/workspace-types";
import type { AppRpcClient } from "../../client/rpc-client";
import { getClient, output, sessionArg } from "./_utils";

const SOURCE_ALIASES: Record<string, string> = {
  term: "terminal",
  terminal: "terminal",
  browser: "browser",
  editor: "editor",
  explorer: "explorer"
};

const DIRECTIONS = new Set(["left", "right", "above", "below", "within"]);

type ResolvedSource = { kind: string; viewKey?: string; defaultPlacement?: string };

function resolveAlias(source: string): ResolvedSource | null {
  const kind = SOURCE_ALIASES[source];
  return kind ? { kind } : null;
}

async function resolveFromRpc(source: string, client: AppRpcClient): Promise<ResolvedSource> {
  const { sources } = await client.call("pane.sources", undefined);

  // Match by qualified ID first
  const byId = sources.find((s) => s.qualifiedId === source);
  if (byId) return toResolved(byId);

  // Match by label (case-insensitive)
  const lower = source.toLowerCase();
  const matches = sources.filter((s) => s.label.toLowerCase() === lower);

  if (matches.length === 1) return toResolved(matches[0]!);
  if (matches.length > 1) {
    const ids = matches.map((m) => m.qualifiedId).join(", ");
    throw new Error(`Ambiguous source "${source}". Use qualified ID: ${ids}`);
  }

  throw new Error(`Unknown source "${source}". Run 'flmux open --list' to see available sources.`);
}

function toResolved(info: PaneSourceInfo): ResolvedSource {
  return { kind: info.kind, viewKey: info.viewKey, defaultPlacement: info.defaultPlacement };
}

function buildLeaf(resolved: ResolvedSource, args: Record<string, unknown>): PaneCreateInput {
  const title = typeof args.title === "string" ? args.title : undefined;

  switch (resolved.kind) {
    case "terminal": {
      const rendererArg = typeof args.renderer === "string" ? args.renderer : undefined;
      if (rendererArg && !isTerminalRenderer(rendererArg)) {
        throw new Error(`Invalid terminal renderer: ${rendererArg}`);
      }
      const cmdArg = typeof args.cmd === "string" ? args.cmd.trim() : undefined;
      return {
        kind: "terminal",
        title,
        cwd: (typeof args.cwd === "string" ? args.cwd : undefined) ?? (process.env.FLMUX_APP_IPC ? process.cwd() : undefined),
        shell: typeof args.shell === "string" ? args.shell : undefined,
        renderer: isTerminalRenderer(rendererArg) ? rendererArg : undefined,
        startupCommands: cmdArg ? [cmdArg] : undefined
      };
    }
    case "browser":
      return { kind: "browser", title, url: typeof args.url === "string" ? args.url : undefined };
    case "editor":
      return { kind: "editor", title, filePath: typeof args.file === "string" ? args.file : undefined };
    case "explorer":
      return { kind: "explorer", title, rootPath: typeof args.path === "string" ? args.path : process.cwd(), mode: typeof args.mode === "string" ? args.mode as "filetree" | "dirtree" | "filelist" : undefined };
    case "view":
      if (!resolved.viewKey) throw new Error("View source has no viewKey");
      return { kind: "view", title, viewKey: resolved.viewKey };
    default:
      throw new Error(`Unknown pane kind: ${resolved.kind}`);
  }
}

async function resolveReferencePaneId(client: AppRpcClient, explicitPaneId?: string): Promise<string | undefined> {
  if (explicitPaneId) return explicitPaneId;
  if (process.env.FLMUX_PANE_ID) return process.env.FLMUX_PANE_ID;
  const summary = await client.call("app.summary", undefined);
  return summary.activePaneId ?? undefined;
}

function formatSourceTable(sources: PaneSourceInfo[]): string {
  const header = "SOURCE                         LABEL        KIND       SINGLETON";
  const rows = sources.map((s) => {
    const id = s.qualifiedId.padEnd(30);
    const label = s.label.padEnd(12);
    const kind = s.kind.padEnd(10);
    const singleton = s.singleton ? "yes" : "";
    return `${id} ${label} ${kind} ${singleton}`;
  });
  return [header, ...rows].join("\n");
}

/** Core open logic — reused by `split` as a thin wrapper. */
export async function executeOpen(
  client: AppRpcClient,
  source: string,
  direction: string | undefined,
  paneRef: string | undefined,
  args: Record<string, unknown>
): Promise<void> {
  if (direction && !DIRECTIONS.has(direction)) {
    console.error(`Invalid direction "${direction}". Must be one of: ${[...DIRECTIONS].join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let resolved: ResolvedSource;
  try {
    resolved = resolveAlias(source) ?? await resolveFromRpc(source, client);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const leaf = buildLeaf(resolved, args);

  const effectiveDirection = direction ?? resolved.defaultPlacement ?? (paneRef ? "within" : undefined);
  const referencePaneId = paneRef ? await resolveReferencePaneId(client, paneRef) : undefined;

  const result = await client.call("pane.open", {
    leaf,
    referencePaneId: referencePaneId ? asPaneId(referencePaneId) : undefined,
    direction: effectiveDirection as PaneCreateDirection | undefined
  });

  output(result);
}

export default defineCommand({
  meta: { name: "open", description: "Open a pane from any source" },
  args: {
    ...sessionArg,
    source: { type: "positional", description: "Pane source: term, browser, editor, explorer, or extension ID", required: false },
    direction: { type: "positional", description: "Placement: left, right, above, below, within", required: false },
    pane: { type: "string", description: "Reference pane ID for split placement" },
    title: { type: "string", description: "Pane title" },
    list: { type: "boolean", description: "List available pane sources" },
    // Terminal
    cwd: { type: "string", description: "Working directory (terminal)" },
    shell: { type: "string", description: "Shell path (terminal)" },
    renderer: { type: "string", description: "Terminal renderer: xterm, ghostty" },
    cmd: { type: "string", description: "Startup command (terminal)" },
    // Browser
    url: { type: "string", description: "URL (browser)" },
    // Editor
    file: { type: "string", description: "File path (editor)" },
    // Explorer
    path: { type: "string", description: "Root path (explorer)" },
    mode: { type: "string", description: "Explorer mode: filetree, dirtree, filelist" }
  },
  run: async ({ args }) => {
    // --list: enumerate available pane sources
    if (args.list) {
      try {
        const client = await getClient(args.session);
        const { sources } = await client.call("pane.sources", undefined);
        console.log(formatSourceTable(sources));
      } catch {
        // App not running — show builtin aliases only
        console.log("Builtin sources (extension sources require running app):\n");
        console.log("  term / terminal    Terminal");
        console.log("  browser            Browser");
        console.log("  editor             Editor");
        console.log("  explorer           Explorer");
      }
      return;
    }

    if (!args.source) {
      console.error("Usage: flmux open <source> [direction] [--options]\nRun 'flmux open --list' to see available sources.");
      process.exitCode = 1;
      return;
    }

    const client = await getClient(args.session);
    await executeOpen(client, args.source, args.direction, args.pane, args);
  }
});
