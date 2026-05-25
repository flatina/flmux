import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..");

// Fixed port so the RP origin is known up-front (passkey RP ID is derived from
// FLMUX_PUBLIC_ORIGIN). `localhost` is a WebAuthn secure-context exception —
// the ceremony works over plain http on localhost, and the page MUST be served
// from the same `localhost` host so its origin matches RP ID `localhost`.
const PORT = 4317;
const ORIGIN = `http://localhost:${PORT}`;
const USER = "webuser";

interface WebAppHandle {
  process: ChildProcess;
  rootDir: string;
  authDir: string;
  enrollToken: string;
}

let handle: WebAppHandle | null = null;

/** Add a CTAP2 internal virtual authenticator with a resident (discoverable)
 * key + auto-verified UV, so `navigator.credentials.create/get` complete
 * without hardware. Discoverable is required because login is usernameless. */
async function addVirtualAuthenticator(page: import("@playwright/test").Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      automaticPresenceSimulation: true,
      isUserVerified: true
    }
  });
  return client;
}

function runCli(args: string[]): Record<string, unknown> {
  const result = spawnSync("bun", ["src/cli.ts", ...args], { cwd: APP_DIR, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`CLI ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test.beforeAll(async () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), "flmux-passkey-"));
  const authDir = join(rootDir, ".flmux", "auth");

  // CLI setup against the SAME auth dir the server uses. The running server's
  // tokenStore picks up the new enrollment token via its per-request mtime
  // cache, so the order (CLI before or after startup) doesn't matter for the
  // token to be visible — we do it before startup for determinism.
  runCli(["tokens", "bootstrap", "--auth-dir", authDir]);
  runCli(["auth", "create-user", "--name", USER, "--role", "user", "--allow-pane-kinds", "*", "--auth-dir", authDir]);
  const enroll = runCli(["auth", "enroll", "--user", USER, "--auth-dir", authDir]);
  const enrollToken = enroll.token;
  if (typeof enrollToken !== "string") throw new Error(`auth enroll returned no token: ${JSON.stringify(enroll)}`);

  const appProcess = spawn("bun", ["run", "dev", "--", "--web"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      FLMUX_ROOT_DIR: rootDir,
      FLMUX_DEV_MODE: "1",
      FLMUX_PORT: String(PORT),
      FLMUX_PUBLIC_ORIGIN: ORIGIN
    }
  });

  // Surface server crashes in the test output (vite/build errors etc.).
  appProcess.stderr?.on("data", (c: Buffer) => process.stderr.write(`[flmux-server] ${c}`));

  handle = { process: appProcess, rootDir, authDir, enrollToken };
  await waitForServer(appProcess);
});

test.afterAll(async () => {
  if (!handle) return;
  handle.process.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (!handle.process.killed) handle.process.kill("SIGKILL");
  try {
    rmSync(handle.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // best-effort
  }
});

test("passkey enroll → login → authenticated → logout (full flow)", async ({ browser }) => {
  if (!handle) throw new Error("web app not running");
  const { enrollToken } = handle;

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // Authenticator MUST exist before /enroll so create() is satisfied.
    await addVirtualAuthenticator(page);

    // --- Step 1: Enroll ---
    await page.goto(`${ORIGIN}/enroll?token=${encodeURIComponent(enrollToken)}`);
    await expect(page.locator("#go")).toBeEnabled();
    await page.locator("#go").click();
    await expect(page.locator("#status")).toContainText("registered", { timeout: 15_000 });
    const enrollStatus = await page.locator("#status").textContent();
    console.log(`[step1 enroll] #status = ${JSON.stringify(enrollStatus)}`);

    // The credential lands in the virtual authenticator. A discoverable
    // (resident) key is required for the usernameless login below.

    // --- Step 2: Login (usernameless) ---
    await page.goto(`${ORIGIN}/login`);
    await expect(page.locator("#go")).toBeEnabled();
    await page.locator("#go").click();
    // Page sets #status "Signed in. Redirecting…" then navigates to "/".
    await expect(page).toHaveURL(`${ORIGIN}/`, { timeout: 15_000 });
    console.log(`[step2 login] landed on ${page.url()}`);

    const cookies = await context.cookies(ORIGIN);
    const session = cookies.find((c) => c.name === "flmux_web_token");
    console.log(`[step2 login] session cookie present = ${Boolean(session)} value-prefix = ${session?.value.slice(0, 8)}`);
    expect(session, "flmux_web_token session cookie must be set after login").toBeTruthy();
    expect(session!.value.length).toBeGreaterThan(0);

    // --- Step 3: Authenticated request ---
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const clientsRes = await fetch(`${ORIGIN}/api/clients`, { headers: { cookie: cookieHeader } });
    const clientsBody = await clientsRes.text();
    console.log(`[step3 authed] GET /api/clients → ${clientsRes.status}`);
    expect(clientsRes.status, "/api/clients with session cookie must be 200").toBe(200);
    const parsed = JSON.parse(clientsBody) as { clients?: unknown[] };
    expect(Array.isArray(parsed.clients), "/api/clients returns a clients array").toBe(true);

    // Sanity: an UNauthenticated *navigation* redirects to /login (the gate is
    // real, so the 200 above is meaningful). The server only redirects on a
    // genuine top-level navigation (`isNavigationRequest`: Sec-Fetch-Mode
    // navigate); a bare XHR keeps the 401. A real browser context with no
    // cookie is the authentic navigation — assert it lands on /login.
    const anonCtx = await browser.newContext();
    try {
      const anonPage = await anonCtx.newPage();
      await anonPage.goto(`${ORIGIN}/`);
      console.log(`[step3 gate] anonymous browser nav to / → url ${anonPage.url()}`);
      await expect(anonPage).toHaveURL(`${ORIGIN}/login`, { timeout: 10_000 });
    } finally {
      await anonCtx.close();
    }

    // --- Step 4: Logout ---
    const logoutRes = await fetch(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader }
    });
    console.log(`[step4 logout] POST /api/auth/logout → ${logoutRes.status} set-cookie=${logoutRes.headers.get("set-cookie")}`);
    expect(logoutRes.status).toBe(200);

    // The logout response clears the cookie via Set-Cookie Max-Age=0; apply it
    // to the browser context, then a fresh navigation must redirect to /login.
    await context.clearCookies();
    const afterLogout = await page.goto(`${ORIGIN}/`);
    console.log(`[step4 logout] post-logout GET / → status ${afterLogout?.status()} url ${page.url()}`);
    await expect(page).toHaveURL(`${ORIGIN}/login`, { timeout: 10_000 });

    // Also confirm server-side the old token is now rejected (session deleted,
    // not just cookie cleared client-side).
    const reuse = await fetch(`${ORIGIN}/api/clients`, { headers: { cookie: cookieHeader } });
    console.log(`[step4 logout] reuse old session cookie on /api/clients → ${reuse.status}`);
    expect(reuse.status, "old session token must be rejected after logout").not.toBe(200);
  } finally {
    await context.close();
  }
});

/** Poll /login until the dev server (vite build + bun boot) is serving. The
 * `dev` script runs `vite build` first, which can take 30–60s cold. */
async function waitForServer(proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  let exited = false;
  proc.on("exit", (code) => {
    exited = true;
    process.stderr.write(`[flmux-server] exited early code=${code}\n`);
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error("flmux --web exited before it started listening");
    try {
      const res = await fetch(`${ORIGIN}/login`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${ORIGIN}/login`);
}
