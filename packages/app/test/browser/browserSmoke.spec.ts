import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..");

interface WebAppHandle {
  process: ChildProcess;
  authDir: string;
  origin: string;
  token: string;
}

let handle: WebAppHandle | null = null;

test.beforeAll(async () => {
  const authDir = mkdtempSync(resolve(tmpdir(), "flmux-browser-smoke-auth-"));
  const tokenProcess = spawn(
    "bun",
    ["src/cli.ts", "tokens", "bootstrap", "--auth-dir", authDir],
    { cwd: APP_DIR, shell: process.platform === "win32" }
  );
  const tokenOutput = await collectOutput(tokenProcess);
  const bootstrap = JSON.parse(tokenOutput) as { token: string };

  const appProcess = spawn(
    "bun",
    ["run", "dev", "--", "--web"],
    {
      cwd: APP_DIR,
      env: { ...process.env, FLMUX_AUTH_DIR: authDir, FLMUX_DEV_MODE: "1" },
      shell: process.platform === "win32"
    }
  );

  const origin = await waitForOrigin(appProcess);
  handle = { process: appProcess, authDir, origin, token: bootstrap.token };
});

test.afterAll(async () => {
  if (!handle) return;
  handle.process.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (!handle.process.killed) handle.process.kill("SIGKILL");
  try {
    rmSync(handle.authDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("workbench bootstraps and mounts in real browser", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${handle.origin}/?token=${encodeURIComponent(handle.token)}`);
    // Workbench mounts a `.dockview-shell` root once bootstrap completes +
    // the first `shellCore.event` subscribes. Wait for it as the smoke
    // end-state: all of bootstrap + WS attach + dockview render succeeded.
    await expect(page.locator(".dockview-shell")).toBeVisible({ timeout: 20_000 });
    // Seeded workspace.1 pane should exist (cowsay + browser from seedWorkspace).
    await expect(page.locator('.workspace-panel[data-workspace-id="workspace.1"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

async function collectOutput(proc: ChildProcess): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolveFn(stdout);
      else reject(new Error(`process exited ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function waitForOrigin(proc: ChildProcess): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => {
      reject(new Error("timed out waiting for web origin — server didn't start"));
    }, 30_000);
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /\[flmux\] web origin: (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (match) {
        clearTimeout(deadline);
        resolveFn(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`flmux --web exited early with code ${code}`));
    });
  });
}

