import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FlmuxClientRegistry } from "../src/main/clientRegistry";
import { startFlmuxServer } from "../src/main/server";
import { createShellModelRouter } from "../src/main/shellModelBridge";
import { forwardTerminalEventToOwnedClient } from "../src/main/terminalEventForwarding";
import { createTerminalService } from "../src/main/terminal-service";
import type { ShellModelAPI } from "../src/renderer/shell/types";
import type { FlmuxRendererBridge } from "../src/shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../src/shared/terminal";
import { stopOwnedPtydDaemonsForRootDir } from "./support/ptydCleanup";
import { TestShellModelHost } from "./support/testShellModelHost";
import { waitFor } from "./support/waitFor";

export interface SmokeHarness {
  readonly origin: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly workspaceRootDir: string;
  fetchJson<T>(pathname: string, init?: RequestInit): Promise<T>;
  runCliJson<T>(args: string[], options?: { withClient?: boolean }): Promise<T>;
  waitFor<T>(probe: () => Promise<T | null>, options?: { timeoutMs?: number; intervalMs?: number; label?: string }): Promise<T>;
  dispose(): Promise<void>;
}

export async function createSmokeHarness(): Promise<SmokeHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), "flmux-smoke-"));
  const workspaceRootDir = join(tempDir, "workspace-root");
  const rendererDir = join(tempDir, "renderer");
  const viewId = 1;
  const paneOwners = new Map<string, number>();

  await mkdir(workspaceRootDir, { recursive: true });
  await mkdir(rendererDir, { recursive: true });
  await writeFile(join(rendererDir, "index.html"), "<!doctype html><title>flmux smoke</title>", "utf8");

  const terminalService = createTerminalService();
  const host = new TestShellModelHost({
    workspaceId: "workspace.smoke",
    workspaceTitle: "Workspace Smoke",
    workspaceRootDir,
    appOrigin: "http://127.0.0.1:0",
    runtimeLabel: "smoke-harness",
    terminalService,
    onTerminalCreate(paneId) {
      paneOwners.set(paneId, viewId);
    }
  });
  const shellModel = host.createModel();
  const registry = new FlmuxClientRegistry();
  const router = createShellModelRouter(registry);
  const bridge = createLocalRendererBridge(shellModel, (event) => host.applyTerminalEvent(event));

  registry.attachRenderer(viewId, bridge);
  const { clientId } = router.registerClient(viewId);
  const server = startFlmuxServer({
    rendererDir,
    shellModelRouter: router
  });
  host.setAppOrigin(server.origin);

  const unsubscribeTerminal = terminalService.subscribe((event) => {
    forwardTerminalEventToOwnedClient({
      event,
      paneOwners,
      clientRegistry: registry
    });
  });

  return {
    origin: server.origin,
    clientId,
    workspaceId: host.workspaceId,
    workspaceRootDir,
    fetchJson(pathname, init) {
      return fetchJson(`${server.origin}${pathname}`, init);
    },
    async runCliJson(args, options) {
      return runCliJson(args, {
        clientId,
        origin: server.origin,
        withClient: options?.withClient ?? true
      });
    },
    waitFor(probe, options) {
      return waitFor(probe, options);
    },
    async dispose() {
      unsubscribeTerminal();
      await stopOwnedPtydDaemonsForRootDir(workspaceRootDir);
      await terminalService.dispose?.();
      server.stop();
      registry.detachRenderer(viewId);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function createLocalRendererBridge(
  shellModel: ShellModelAPI,
  onTerminalEvent: (event: TerminalRuntimeEvent) => void
): FlmuxRendererBridge {
  return {
    requestProxy: {
      "shellModel.path.get": (params: { path: string }) => shellModel.pathGet(params.path),
      "shellModel.path.list": (params: { path: string }) => shellModel.pathList(params.path),
      "shellModel.path.set": (params: { path: string; value: unknown }) =>
        shellModel.pathSet(params.path, params.value),
      "shellModel.path.call": (params: { path: string; args?: Record<string, unknown> }) =>
        shellModel.pathCall(params.path, params.args)
    },
    sendProxy: {
      "terminal.event": (payload: TerminalRuntimeEvent) => {
        onTerminalEvent(payload);
      }
    }
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function runCliJson<T>(
  args: string[],
  options: {
    origin: string;
    clientId: string;
    withClient: boolean;
  }
): Promise<T> {
  const cmd = [
    resolveBunCommand(),
    "src/cli.ts",
    ...args,
    "--origin",
    options.origin,
    ...(options.withClient ? ["--client", options.clientId] : [])
  ];
  const subprocess = Bun.spawn({
    cmd,
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(`CLI failed (${exitCode}): ${stderr || stdout}`.trim());
  }

  return JSON.parse(stdout) as T;
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}
