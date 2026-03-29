import { resolve } from "node:path";
import type { AppRpcClient } from "../../src/flmux/client/rpc-client";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import type { PropertyChangeEvent } from "../../src/types/property";

export const projectRoot = resolve(import.meta.dir, "../..");

/** Poll until the app is reachable, max waitMs. */
export async function waitForApp(waitMs = 5000, intervalMs = 100): Promise<AppRpcClient> {
  const deadline = Date.now() + waitMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const session = await resolveSession();
      const client = createAppRpcClient({ ipcPath: session.ipcPath });
      await client.call("system.ping", undefined);
      await client.call("app.summary", undefined);
      return client;
    } catch (e) {
      lastError = e;
      await sleep(intervalMs);
    }
  }

  throw new Error(`App not reachable after ${waitMs}ms: ${lastError}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS — ${label}`);
  } else {
    console.error(`  FAIL — ${label}`);
    process.exitCode = 1;
  }
}

/** Spawn `bun <args>` synchronously from project root and capture output. */
export function runCli(args: string[], env: Record<string, string | undefined>) {
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

/** Poll an event array until a matching PropertyChangeEvent appears. */
export async function waitForPropertyEvent(
  events: PropertyChangeEvent[],
  predicate: (event: PropertyChangeEvent) => boolean,
  timeoutMs = 5000
): Promise<PropertyChangeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) {
      return match;
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for property change event");
}
