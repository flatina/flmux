import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveFlmuxAuthPaths, type FlmuxAuthPaths } from "./main/auth/authConfig";
import { resolveFlmuxPaths } from "./main/flmuxPaths";
import { generateToken, generateUserHandle } from "./main/auth/tokenFormat";
import { createTokenStore } from "./main/auth/tokenStore";
import { createUserStore, isPathSafeUserName, type AllowPaneKinds, type FlmuxUser } from "./main/auth/userStore";
import { createWebauthnStore } from "./main/auth/webauthnStore";
import { stringifyUsersToml } from "./main/auth/tomlWriter";
import { generateDisplayName, validateDisplayName } from "./main/auth/displayName";

const ENROLLMENT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function runAuthCli(rawArgs: string[]): Promise<unknown> {
  const [subcommand, ...rest] = rawArgs;
  if (!subcommand) {
    throw new Error("auth requires a subcommand (create-user | enroll | credentials)");
  }

  const { authDir, argv } = extractAuthDirFlag(rest);
  const paths = resolveFlmuxAuthPaths(authDir ?? resolveCliAuthDir());

  switch (subcommand) {
    case "create-user":
      return createUser(paths, argv);
    case "enroll":
      return enroll(paths, argv);
    case "credentials":
      return credentials(paths, argv);
    default:
      throw new Error(`Unknown auth subcommand: ${subcommand}`);
  }
}

/** `/enroll?token=` link the user opens to register a first passkey. The token
 * is a one-time secret — deliver over a confidential channel, never a shared
 * plaintext link (a leaked token = first-use account takeover). */
export function buildEnrollUrl(origin: string, token: string): string {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(normalizedOrigin)) {
    throw new Error(`auth enroll: --origin must start with http:// or https:// (got '${origin}')`);
  }
  return `${normalizedOrigin}/enroll?token=${encodeURIComponent(token)}`;
}

function createUser(paths: FlmuxAuthPaths, argv: string[]) {
  const name = readFlag(argv, "--name");
  if (!name) {
    throw new Error("auth create-user: --name <name> is required");
  }
  if (!isPathSafeUserName(name)) {
    throw new Error(
      `auth create-user: --name must be a path-safe key (ASCII letters, digits, '.', '_', '-'; not '.'/'..') — it becomes the /w/u/<name> dir`
    );
  }
  const role = readFlag(argv, "--role") ?? "basic";
  const allowPaneKindsArg = readFlag(argv, "--allow-pane-kinds");
  const displayNameArg = readFlag(argv, "--display-name");
  const displayName = displayNameArg ? validateDisplayName(displayNameArg) : generateDisplayName();

  const userStore = createUserStore(paths.usersFile);
  if (userStore.getUser(name)) {
    throw new Error(`User '${name}' already exists in ${paths.usersFile}`);
  }

  // Preset roles (dev/tech/basic) derive pane-kinds + fs from the role on load;
  // custom roles need an explicit pane-kind allowlist. fs fields default here
  // and the preset fills them in `parseUser` (writer omits defaults).
  const presetRole = role === "dev" || role === "tech" || role === "basic";
  const allowPaneKinds: AllowPaneKinds = allowPaneKindsArg
    ? parseAllowPaneKinds(allowPaneKindsArg)
    : presetRole
      ? "*"
      : [];

  const user: FlmuxUser = {
    name,
    handle: generateUserHandle(),
    displayName,
    role,
    allowPaneKinds,
    denyPaneKinds: [],
    allowPaths: "*",
    fsUnconfined: false,
    dirsRw: [],
    dirsRo: []
  };
  writeUsersFile(paths.usersFile, [...userStore.listUsers(), user]);

  return { ok: true, authDir: paths.authDir, user: name, role, displayName };
}

async function enroll(paths: FlmuxAuthPaths, argv: string[]) {
  const userName = readFlag(argv, "--user");
  if (!userName) {
    throw new Error("auth enroll: --user <name> is required");
  }
  const origin = readFlag(argv, "--origin") ?? process.env.FLMUX_PUBLIC_ORIGIN ?? process.env.FLMUX_ORIGIN;

  const userStore = createUserStore(paths.usersFile);
  if (!userStore.getUser(userName)) {
    throw new Error(`User '${userName}' not found in ${paths.usersFile}`);
  }

  const generated = generateToken();
  const tokenStore = createTokenStore(paths.tokensFile);
  tokenStore.append({
    id: generated.id,
    user: userName,
    tokenHash: generated.hash,
    tokenPrefix: generated.prefix,
    createdAt: new Date().toISOString(),
    // Separate namespace — authorize() never resolves this to a session.
    kind: "enrollment",
    label: "enroll",
    expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString()
  });

  const url = origin ? buildEnrollUrl(origin, generated.value) : undefined;
  if (url) {
    const qrcode = (await import("qrcode-terminal")).default;
    await new Promise<void>((resolveQr) => {
      qrcode.generate(url, { small: true }, (rendered: string) => {
        process.stdout.write(`${rendered}\n${url}\n`);
        resolveQr();
      });
    });
  }

  return {
    ok: true,
    authDir: paths.authDir,
    user: userName,
    tokenId: generated.id,
    token: generated.value,
    enrollUrl: url,
    expiresInMinutes: ENROLLMENT_TTL_MS / 60_000
  };
}

function credentials(paths: FlmuxAuthPaths, argv: string[]) {
  const action = argv[0];
  if (action === "list") {
    return listCredentials(paths, argv.slice(1));
  }
  if (action === "revoke") {
    return revokeCredential(paths, argv.slice(1));
  }
  throw new Error("auth credentials requires list|revoke");
}

function listCredentials(paths: FlmuxAuthPaths, argv: string[]) {
  const userName = readFlag(argv, "--user");
  if (!userName) {
    throw new Error("auth credentials list: --user <name> is required");
  }
  const store = createWebauthnStore(paths.webauthnFile);
  return {
    ok: true,
    authDir: paths.authDir,
    user: userName,
    credentials: store.listForUser(userName).map((c) => ({
      credentialId: c.credentialId,
      label: c.label,
      signCount: c.signCount,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      needsReview: c.needsReview ?? false
    }))
  };
}

function revokeCredential(paths: FlmuxAuthPaths, argv: string[]) {
  const userName = readFlag(argv, "--user");
  const credentialId = readFlag(argv, "--credential-id") ?? argv.find((a) => !a.startsWith("--"));
  if (!userName) {
    throw new Error("auth credentials revoke: --user <name> is required");
  }
  if (!credentialId) {
    throw new Error("auth credentials revoke: --credential-id <id> is required");
  }

  const store = createWebauthnStore(paths.webauthnFile);
  const existing = store.findByCredentialId(credentialId);
  if (!existing || existing.user !== userName) {
    throw new Error(`Credential '${credentialId}' not found for user '${userName}'`);
  }
  store.removeByCredentialId(credentialId);
  return { ok: true, authDir: paths.authDir, user: userName, credentialId };
}

function writeUsersFile(filePath: string, users: readonly FlmuxUser[]) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, stringifyUsersToml(users), "utf8");
  renameSync(tmpPath, filePath);
}

function parseAllowPaneKinds(raw: string): AllowPaneKinds {
  const trimmed = raw.trim();
  if (trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function extractAuthDirFlag(argv: string[]): { authDir: string | null; argv: string[] } {
  const index = argv.indexOf("--auth-dir");
  if (index < 0 || index + 1 >= argv.length) {
    return { authDir: null, argv };
  }
  const value = argv[index + 1];
  const remaining = [...argv.slice(0, index), ...argv.slice(index + 2)];
  return { authDir: value, argv: remaining };
}

function resolveCliAuthDir(): string {
  const rootOverride = process.env.FLMUX_ROOT_DIR?.trim();
  if (!rootOverride) {
    throw new Error("auth: --auth-dir <dir> is required (or set FLMUX_ROOT_DIR to derive <rootDir>/.flmux/auth)");
  }
  return resolveFlmuxPaths(resolve(rootOverride)).authDir;
}
