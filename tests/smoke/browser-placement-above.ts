import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getFlmuxLastPath } from "../../src/shared/paths";
import { assert, sleep, waitForApp } from "./helpers";
import { resolveSession } from "../../src/cli/session-discovery";

const projectRoot = resolve(import.meta.dir, "../..");

function runCli(args: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd: projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    code: result.exitCode,
    stdout: Buffer.from(result.stdout).toString().trim(),
    stderr: Buffer.from(result.stderr).toString().trim()
  };
}

async function main() {
  const client = await waitForApp();
  await sleep(3000);

  const session = await resolveSession();
  const summary = await client.call("app.summary", undefined);
  const terminal = summary.panes.find((pane) => pane.kind === "terminal");
  if (!terminal) throw new Error("no terminal pane");

  const env = {
    ...process.env,
    FLMUX_APP_IPC: session.ipcPath,
    FLMUX_PANE_ID: String(terminal.paneId)
  };

  const created = runCli(
    ["src/cli/index.ts", "browser", "new", "--placement", "above", "https://example.com"],
    env
  );
  assert(created.code === 0, `browser new above exits 0 (${created.stderr || "ok"})`);
  await sleep(1000);

  const layout = JSON.parse(await readFile(getFlmuxLastPath(), "utf-8")) as {
    workspaceLayout?: {
      panels?: Record<string, { params?: { innerLayout?: { grid?: { root?: { data?: Array<{ type?: string; data?: Array<{ type?: string }> }> }; orientation?: string } } } }>;
    };
  };
  const inner = firstInnerLayout(layout);
  const rootChildren = inner?.grid?.root?.data ?? [];
  const firstNode = rootChildren[0];
  assert(inner?.grid?.orientation === "HORIZONTAL", `explicit above keeps root orientation (${inner?.grid?.orientation ?? "missing"})`);
  assert(rootChildren.length === 1, `explicit above keeps a single root child (${rootChildren.length})`);
  assert(firstNode?.type === "branch", `explicit above creates nested branch (${firstNode?.type ?? "missing"})`);
  assert((firstNode?.data?.length ?? 0) === 2, `explicit above nested branch contains two leaves (${firstNode?.data?.length ?? 0})`);

  await client.call("browser.close", { paneId: created.stdout as any });

  console.log("\nBrowser above placement checks passed.");
}

function firstInnerLayout(file: {
  workspaceLayout?: {
    panels?: Record<string, { params?: { innerLayout?: unknown } }>;
  };
}) {
  if (!file.workspaceLayout?.panels) {
    return null;
  }

  for (const panel of Object.values(file.workspaceLayout.panels)) {
    const innerLayout = panel.params?.innerLayout;
    if (innerLayout && typeof innerLayout === "object") {
      return innerLayout as {
        grid?: { root?: { data?: Array<{ type?: string; data?: Array<{ type?: string }> }> }; orientation?: string };
      };
    }
  }

  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
