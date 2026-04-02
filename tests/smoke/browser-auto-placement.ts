import { readFile } from "node:fs/promises";
import { getFlmuxLastPath } from "../../src/lib/paths";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import { assert, runCli, sleep, waitForApp } from "./helpers";

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

  const autoCreated = runCli(["src/flmux/cli/index.ts", "browser", "new", `${summary.webServerUrl}/health`], env);
  assert(autoCreated.code === 0, `browser new auto exits 0 (${autoCreated.stderr || "ok"})`);
  await sleep(1000);

  const autoLayout = JSON.parse(await readFile(getFlmuxLastPath(), "utf-8")) as {
    workspaceLayout?: {
      panels?: Record<string, { params?: { innerLayout?: { grid?: { root?: { data?: Array<{ size?: number }> }; orientation?: string }; panels?: Record<string, unknown> } } }>;
    };
  };
  const autoInner = firstInnerLayout(autoLayout);
  assert(autoInner?.grid?.orientation === "HORIZONTAL", `auto placement uses horizontal split (${autoInner?.grid?.orientation ?? "missing"})`);
  assert((autoInner?.grid?.root?.data?.length ?? 0) === 2, `auto placement creates two split leaves (${autoInner?.grid?.root?.data?.length ?? 0})`);

  await client.call("pane.close", { paneId: autoCreated.stdout as any });

  console.log("\nBrowser auto placement checks passed.");
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
        grid?: { root?: { data?: Array<{ size?: number }> }; orientation?: string };
        panels?: Record<string, unknown>;
      };
    }
  }

  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

