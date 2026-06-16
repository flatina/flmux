import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// `${enc:<base64url>}` — host-bound encrypted config value. AES-256-GCM, at-rest
// confidentiality only (NOT config integrity — see .agents security). The
// envelope header (version|flags|keyId) is folded into the AEAD AAD so it is
// tamper-evident; keyId is a diagnostic hint, the GCM tag is the proof of key.
const VERSION = 1;
const FLAG_AAD_BOUND = 0x01;
const KNOWN_FLAGS = FLAG_AAD_BOUND;
const KEYID_LEN = 4;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 2 + KEYID_LEN; // version + flags + keyId
const PREFIX = "${enc:";
const SUFFIX = "}";

export const CONFIG_KEY_BYTES = 32;

function keyId(key: Buffer): Buffer {
  return createHash("sha256").update(key).digest().subarray(0, KEYID_LEN);
}

/** AEAD AAD = header [‖ ctx]. The header is always authenticated; ctx only when
 * the value is aad-bound. */
function aad(header: Buffer, ctx: string | undefined): Buffer {
  return ctx === undefined ? header : Buffer.concat([header, Buffer.from(ctx, "utf8")]);
}

function requireKey(key: Buffer): void {
  if (key.length !== CONFIG_KEY_BYTES) throw new Error(`config key must be ${CONFIG_KEY_BYTES} bytes`);
}

export function isEncValue(value: string): boolean {
  return value.startsWith(PREFIX) && value.endsWith(SUFFIX);
}

/** Encrypt → `${enc:<base64url>}`. Host CLI only (not the extension surface). */
export function encryptEnvelope(plaintext: string, opts: { key: Buffer; aad?: string }): string {
  requireKey(opts.key);
  const flags = opts.aad === undefined ? 0 : FLAG_AAD_BOUND;
  const header = Buffer.concat([Buffer.from([VERSION, flags]), keyId(opts.key)]);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", opts.key, nonce);
  cipher.setAAD(aad(header, opts.aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = Buffer.concat([header, nonce, cipher.getAuthTag(), ct]);
  return PREFIX + envelope.toString("base64url") + SUFFIX;
}

/** Decrypt a `${enc:...}` value (or bare base64url envelope). Returns plaintext
 * only after tag verification; throws a generic error on any failure (never
 * leaks plaintext/key). `aad` must be present iff the value is aad-bound. */
export function decryptEnvelope(value: string, opts: { key: Buffer; aad?: string }): string {
  requireKey(opts.key);
  const b64 = isEncValue(value) ? value.slice(PREFIX.length, -SUFFIX.length) : value;
  const env = Buffer.from(b64, "base64url");
  if (env.toString("base64url") !== b64) throw new Error("enc: malformed envelope");
  if (env.length < HEADER_LEN + NONCE_LEN + TAG_LEN) throw new Error("enc: malformed envelope");
  const version = env[0]!;
  const flags = env[1]!;
  if (version !== VERSION) throw new Error(`enc: unsupported version ${version}`);
  if (flags & ~KNOWN_FLAGS) throw new Error("enc: unknown flags");
  const header = env.subarray(0, HEADER_LEN);
  const envKeyId = env.subarray(2, 2 + KEYID_LEN);
  const nonce = env.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const tag = env.subarray(HEADER_LEN + NONCE_LEN, HEADER_LEN + NONCE_LEN + TAG_LEN);
  const ct = env.subarray(HEADER_LEN + NONCE_LEN + TAG_LEN);
  // Diagnostic hint only (distinguish wrong-key from tampered); not a trust signal.
  if (!keyId(opts.key).equals(envKeyId)) throw new Error("enc: key mismatch");
  const aadBound = (flags & FLAG_AAD_BOUND) !== 0;
  if (aadBound !== (opts.aad !== undefined)) {
    throw new Error(aadBound ? "enc: aad required" : "enc: unexpected aad");
  }
  const decipher = createDecipheriv("aes-256-gcm", opts.key, nonce);
  decipher.setAAD(aad(header, opts.aad));
  decipher.setAuthTag(tag);
  try {
    // final() verifies the tag and throws on mismatch — only then is the
    // accumulated plaintext authenticated and safe to return.
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("enc: decryption failed");
  }
}
