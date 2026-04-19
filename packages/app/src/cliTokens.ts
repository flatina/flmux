import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  resolveFlmuxAuthDir,
  resolveFlmuxAuthPaths,
  type FlmuxAuthPaths
} from "./main/auth/authConfig";
import { generateToken } from "./main/auth/tokenFormat";
import { createTokenStore } from "./main/auth/tokenStore";
import { createUserStore, type AllowPaneKinds, type FlmuxUser } from "./main/auth/userStore";
import { stringifyUsersToml } from "./main/auth/tomlWriter";

export async function runTokensCli(rawArgs: string[]): Promise<unknown> {
  const [subcommand, ...rest] = rawArgs;
  if (!subcommand) {
    throw new Error("tokens requires a subcommand (bootstrap | issue | revoke | list | users | qr)");
  }

  if (subcommand === "qr") {
    return renderQr(rest);
  }

  const { authDir, argv } = extractAuthDirFlag(rest);
  const paths = resolveFlmuxAuthPaths(authDir ?? resolveFlmuxAuthDir());

  switch (subcommand) {
    case "bootstrap":
      return bootstrap(paths, argv);
    case "issue":
      return issue(paths, argv);
    case "revoke":
      return revoke(paths, argv);
    case "list":
      return listTokens(paths);
    case "users":
      return listUsers(paths);
    default:
      throw new Error(`Unknown tokens subcommand: ${subcommand}`);
  }
}

export function buildAttachUrl(origin: string, token: string): string {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(normalizedOrigin)) {
    throw new Error(`tokens qr: --origin must start with http:// or https:// (got '${origin}')`);
  }
  return `${normalizedOrigin}/?token=${encodeURIComponent(token)}`;
}

async function renderQr(argv: string[]): Promise<undefined> {
  const tokenValue = readFlag(argv, "--token");
  const origin = readFlag(argv, "--origin");
  if (!tokenValue) {
    throw new Error("tokens qr: --token <plaintext-token> is required");
  }
  if (!origin) {
    throw new Error("tokens qr: --origin <url> is required");
  }

  const url = buildAttachUrl(origin, tokenValue);
  const qrcode = (await import("qrcode-terminal")).default;

  await new Promise<void>((resolve) => {
    qrcode.generate(url, { small: true }, (rendered: string) => {
      process.stdout.write(`${rendered}\n`);
      process.stdout.write(`${url}\n`);
      resolve();
    });
  });

  return undefined;
}

function bootstrap(paths: FlmuxAuthPaths, argv: string[]) {
  const userName = readFlag(argv, "--name") ?? "admin";
  const allowPaneKindsArg = readFlag(argv, "--allow-pane-kinds") ?? "*";
  const label = readFlag(argv, "--label") ?? "bootstrap";

  const userStore = createUserStore(paths.usersFile);
  if (userStore.listUsers().length > 0) {
    throw new Error(
      `Auth already bootstrapped (${paths.usersFile} exists). Use 'tokens issue' to add more tokens.`
    );
  }

  const user: FlmuxUser = {
    name: userName,
    allowPaneKinds: parseAllowPaneKinds(allowPaneKindsArg),
    // Bootstrap grants the initial admin full path access. Per-path ACL
    // is opt-in via subsequent hand-edits to users.toml (`allow_paths`
    // table); default `"*"` matches the admin-bootstrap intent.
    allowPaths: "*"
  };
  writeUsersFile(paths.usersFile, [user]);

  return issueTokenFor(paths, userName, { label });
}

function issue(paths: FlmuxAuthPaths, argv: string[]) {
  const userName = readFlag(argv, "--user");
  if (!userName) {
    throw new Error("tokens issue: --user <name> is required");
  }

  const label = readFlag(argv, "--label");
  const expiresAt = readFlag(argv, "--expires-at");
  if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
    throw new Error(`tokens issue: --expires-at '${expiresAt}' is not a valid ISO timestamp`);
  }

  const userStore = createUserStore(paths.usersFile);
  if (!userStore.getUser(userName)) {
    throw new Error(`User '${userName}' not found in ${paths.usersFile}`);
  }

  return issueTokenFor(paths, userName, { label, expiresAt });
}

function revoke(paths: FlmuxAuthPaths, argv: string[]) {
  const tokenId = argv[0];
  if (!tokenId) {
    throw new Error("tokens revoke <tokenId>: tokenId is required");
  }

  const tokenStore = createTokenStore(paths.tokensFile);
  const removed = tokenStore.removeById(tokenId);
  if (!removed) {
    throw new Error(`Token id '${tokenId}' not found in ${paths.tokensFile}`);
  }

  return { ok: true, tokenId, authDir: paths.authDir };
}

function listTokens(paths: FlmuxAuthPaths) {
  const tokenStore = createTokenStore(paths.tokensFile);
  return {
    ok: true,
    authDir: paths.authDir,
    tokens: tokenStore.list().map((token) => ({
      id: token.id,
      user: token.user,
      prefix: token.tokenPrefix,
      createdAt: token.createdAt,
      label: token.label,
      expiresAt: token.expiresAt
    }))
  };
}

function listUsers(paths: FlmuxAuthPaths) {
  const userStore = createUserStore(paths.usersFile);
  return {
    ok: true,
    authDir: paths.authDir,
    users: userStore.listUsers().map((user) => ({
      name: user.name,
      allowPaneKinds: user.allowPaneKinds
    }))
  };
}

function issueTokenFor(
  paths: FlmuxAuthPaths,
  userName: string,
  options: { label?: string; expiresAt?: string }
) {
  const generated = generateToken();
  const tokenStore = createTokenStore(paths.tokensFile);
  tokenStore.append({
    id: generated.id,
    user: userName,
    tokenHash: generated.hash,
    tokenPrefix: generated.prefix,
    createdAt: new Date().toISOString(),
    label: options.label,
    expiresAt: options.expiresAt
  });

  return {
    ok: true,
    authDir: paths.authDir,
    user: userName,
    tokenId: generated.id,
    tokenPrefix: generated.prefix,
    token: generated.value
  };
}

function writeUsersFile(filePath: string, users: readonly FlmuxUser[]) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, stringifyUsersToml(users), "utf8");
  renameSync(tmpPath, filePath);
}

function parseAllowPaneKinds(raw: string): AllowPaneKinds {
  const trimmed = raw.trim();
  if (trimmed === "*") {
    return "*";
  }

  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return undefined;
  }
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
