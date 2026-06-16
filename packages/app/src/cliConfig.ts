import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CONFIG_KEY_BYTES, encryptEnvelope } from "@flmux/extension-api/config-crypto";

// Encrypt-side host key: the systemd credential blob, decrypted via
// `systemd-creds decrypt` (host/root). Dev fallback: a raw-32-byte
// FLMUX_CONFIG_KEY file, dev mode only. Decrypt side reads the same key from the
// service tmpfs (see extension-api/configKey).
const CRED_BLOB = "/etc/flmux/creds/configkey";

export async function runConfigCli(rawArgs: string[]): Promise<unknown> {
  const [subcommand, ...rest] = rawArgs;
  if (subcommand !== "encrypt") {
    throw new Error("config requires a subcommand (encrypt)");
  }
  return encrypt(rest);
}

async function encrypt(argv: string[]): Promise<void> {
  const aad = readAadFlag(argv);
  const key = loadEncryptKey();
  const plaintext = (await readStdin()).replace(/\r?\n$/, "");
  if (!plaintext) throw new Error("config encrypt: no plaintext on stdin");
  // Only the envelope on stdout (clean for piping); returns void so the CLI
  // prints no JSON result that would mix in / leak around the value.
  process.stdout.write(`${encryptEnvelope(plaintext, aad === undefined ? { key } : { key, aad })}\n`);
}

function loadEncryptKey(): Buffer {
  if (existsSync(CRED_BLOB)) {
    const r = spawnSync("systemd-creds", ["decrypt", "--name=configkey", CRED_BLOB, "-"]);
    if (r.status !== 0) {
      throw new Error(`systemd-creds decrypt failed${r.stderr ? `: ${r.stderr.toString().trim()}` : ""}`);
    }
    return requireKeyBytes(r.stdout, CRED_BLOB);
  }
  const devFile = process.env.FLMUX_CONFIG_KEY;
  if (devFile && process.env.FLMUX_DEV_MODE === "1") {
    if (!existsSync(devFile)) throw new Error(`FLMUX_CONFIG_KEY file not found: ${devFile}`);
    return requireKeyBytes(readFileSync(devFile), devFile);
  }
  throw new Error(`config key unavailable: provision ${CRED_BLOB} via set-config-key.sh (or FLMUX_CONFIG_KEY in dev)`);
}

function requireKeyBytes(buf: Buffer, src: string): Buffer {
  if (buf.length !== CONFIG_KEY_BYTES) {
    throw new Error(`config key at ${src} must be ${CONFIG_KEY_BYTES} raw bytes (got ${buf.length})`);
  }
  return buf;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

// `--aad <ctx>` or `--aad=<ctx>`. A present-but-valueless flag throws instead of
// silently emitting an unbound envelope the caller believed was context-bound.
function readAadFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--aad") {
      const val = argv[i + 1];
      if (val === undefined || val === "" || val.startsWith("--")) {
        throw new Error("config encrypt: --aad requires a context value");
      }
      return val;
    }
    if (tok.startsWith("--aad=")) {
      const val = tok.slice("--aad=".length);
      if (val === "") throw new Error("config encrypt: --aad requires a context value");
      return val;
    }
  }
  return undefined;
}
