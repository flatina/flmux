import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFlmuxServer } from "../src/main/server";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("web mode auth", () => {
  it("requires auth for protected surfaces while keeping health public", async () => {
    const rendererDir = await createRendererFixture();
    const server = startFlmuxServer({
      rendererDir,
      shellModelRouter: {
        registerClient: () => ({ clientId: "server-client" }),
        listClients: async () => [{
          clientId: "server-client",
          viewId: 0,
          workspace: {
            id: "workspace.1",
            title: "Workspace 1",
            activePaneId: null,
            paneCount: 1
          }
        }],
        pathGet: async () => ({ ok: true, found: true, value: null }),
        pathList: async () => ({ ok: true, found: true, entries: [] }),
        pathSet: async () => ({ ok: true, value: null }),
        pathCall: async () => ({ ok: true, value: null })
      },
      auth: {
        token: "test-token"
      }
    });

    try {
      const health = await fetch(`${server.origin}/health`);
      expect(health.status).toBe(200);

      const clientsUnauthorized = await fetch(`${server.origin}/api/clients`);
      expect(clientsUnauthorized.status).toBe(401);
      expect(clientsUnauthorized.headers.get("www-authenticate")).toContain("Bearer");

      const initialPage = await fetch(`${server.origin}/?token=test-token`);
      expect(initialPage.status).toBe(200);
      const cookie = initialPage.headers.get("set-cookie");
      expect(cookie).toContain("flmux_web_token=test-token");

      const clientsWithCookie = await fetch(`${server.origin}/api/clients`, {
        headers: {
          cookie: cookie ?? ""
        }
      });
      expect(clientsWithCookie.status).toBe(200);
      expect(await clientsWithCookie.json()).toEqual({
        ok: true,
        clients: [
          {
            clientId: "server-client",
            viewId: 0,
            workspace: {
              id: "workspace.1",
              title: "Workspace 1",
              activePaneId: null,
              paneCount: 1
            }
          }
        ]
      });

      const clientsWithBearer = await fetch(`${server.origin}/api/clients`, {
        headers: {
          authorization: "Bearer test-token"
        }
      });
      expect(clientsWithBearer.status).toBe(200);

      const cliResult = await runCliJson([
        "clients",
        "--origin",
        server.origin,
        "--token",
        "test-token"
      ]);
      expect(cliResult).toEqual({
        ok: true,
        clients: [
          {
            clientId: "server-client",
            viewId: 0,
            workspace: {
              id: "workspace.1",
              title: "Workspace 1",
              activePaneId: null,
              paneCount: 1
            }
          }
        ]
      });
    } finally {
      server.stop();
    }
  });
});

async function createRendererFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "flmux-web-auth-"));
  const rendererDir = join(rootDir, "renderer");
  tempDirs.push(rootDir);
  await mkdir(rendererDir, { recursive: true });
  await writeFile(join(rendererDir, "index.html"), "<!doctype html><title>flmux</title>", "utf8");
  return rendererDir;
}

async function runCliJson(args: string[]) {
  const subprocess = Bun.spawn({
    cmd: [resolveBunCommand(), "src/cli.ts", ...args],
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

  return JSON.parse(stdout) as unknown;
}

function resolveBunCommand() {
  return Bun.which("bun") ?? process.execPath;
}
