import type { AppRpcClient } from "../../src/cli/app-rpc-client";
import { createAppRpcClient } from "../../src/cli/app-rpc-client";
import { resolveSession } from "../../src/cli/session-discovery";

/** Poll until the app is reachable, max waitMs. */
export async function waitForApp(waitMs = 5000, intervalMs = 100): Promise<AppRpcClient> {
  const deadline = Date.now() + waitMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const session = await resolveSession();
      const client = createAppRpcClient({ ipcPath: session.ipcPath });
      await client.call("system.ping", undefined);
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
