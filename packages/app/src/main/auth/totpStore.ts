import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashToken } from "./tokenFormat";
import { verifyTotpStep } from "./totp";
import { normalizeRecoveryCode } from "./recoveryCodes";

/** A user's TOTP enrollment. `secret` is a REVERSIBLE secret (base32 seed) —
 * unlike token/passkey records it cannot be hashed (codes are derived from it),
 * so this whole file is secret-bearing (see store perms). `lastUsedStep` is the
 * highest consumed counter (replay guard). `recoveryHashes` are sha256 of the
 * unused single-use recovery codes. */
export interface TotpEnrollment {
  user: string;
  secret: string;
  lastUsedStep: number;
  recoveryHashes: string[];
  createdAt: string;
}

export interface TotpStore {
  get(user: string): TotpEnrollment | null;
  /** Create/replace a user's enrollment (re-enroll: caller passes fresh secret +
   * recovery hashes; old secret, recovery codes, and step counter are dropped). */
  set(record: TotpEnrollment): void;
  /** Atomically verify a TOTP code and consume its step. Rejects any code whose
   * matched step ≤ lastUsedStep (replay, incl. earlier in-window steps). Single
   * process (instance lock) + fully synchronous → no await yield → no TOCTOU. */
  verifyAndConsume(user: string, code: string, windowSteps: number): boolean;
  /** Atomically consume one single-use recovery code (delete-on-use). */
  consumeRecoveryCode(user: string, code: string): boolean;
  remove(user: string): boolean;
}

// Single wrap point for seed at-rest representation. Identity today (perms-only,
// 0600 + auth-dir TCB); at-rest encryption (key sourced outside the auth dir)
// slots in here without touching callers.
function encodeSecret(secret: string): string {
  return secret;
}
function decodeSecret(stored: string): string {
  return stored;
}

export function createTotpStore(filePath: string): TotpStore {
  function load(): Map<string, TotpEnrollment> {
    const byUser = new Map<string, TotpEnrollment>();
    if (!existsSync(filePath)) return byUser;
    const parsed = Bun.TOML.parse(readFileSync(filePath, "utf8")) as {
      enrollments?: Array<Record<string, unknown>>;
    };
    for (const record of parsed.enrollments ?? []) {
      const e = parseEnrollment(record);
      if (byUser.has(e.user)) throw new Error(`totp.toml: duplicate user '${e.user}'`);
      byUser.set(e.user, e);
    }
    return byUser;
  }

  function persist(byUser: Map<string, TotpEnrollment>) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    // 0600: seed is a reversible secret. (No-op on Windows; deploy target is Linux.)
    writeFileSync(tmpPath, stringify([...byUser.values()]), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  }

  return {
    get(user) {
      return load().get(user) ?? null;
    },
    set(record) {
      const byUser = load();
      byUser.set(record.user, record);
      persist(byUser);
    },
    verifyAndConsume(user, code, windowSteps) {
      const byUser = load();
      const e = byUser.get(user);
      if (!e) return false;
      const step = verifyTotpStep({ secret: decodeSecret(e.secret), code, windowSteps });
      if (step === null || step <= e.lastUsedStep) return false;
      e.lastUsedStep = step;
      persist(byUser);
      return true;
    },
    consumeRecoveryCode(user, code) {
      const byUser = load();
      const e = byUser.get(user);
      if (!e) return false;
      const hash = hashToken(normalizeRecoveryCode(code));
      const idx = e.recoveryHashes.indexOf(hash);
      if (idx < 0) return false;
      e.recoveryHashes.splice(idx, 1);
      persist(byUser);
      return true;
    },
    remove(user) {
      const byUser = load();
      if (!byUser.delete(user)) return false;
      persist(byUser);
      return true;
    }
  };
}

function parseEnrollment(raw: Record<string, unknown>): TotpEnrollment {
  return {
    user: requireString(raw.user, "user"),
    secret: decodeSecret(requireString(raw.secret, "secret")),
    lastUsedStep: typeof raw.last_used_step === "number" ? raw.last_used_step : 0,
    recoveryHashes: Array.isArray(raw.recovery_hashes)
      ? raw.recovery_hashes.filter((h): h is string => typeof h === "string")
      : [],
    createdAt: requireString(raw.created_at, "created_at")
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`totp.toml: field '${field}' must be a non-empty string`);
  }
  return value;
}

function stringify(enrollments: readonly TotpEnrollment[]): string {
  const lines = ["# totp.toml — SECRET (TOTP seeds). flmux-managed; do not edit or copy.", ""];
  for (const e of enrollments) {
    lines.push("[[enrollments]]");
    lines.push(`user = ${tomlString(e.user)}`);
    lines.push(`secret = ${tomlString(encodeSecret(e.secret))}`);
    lines.push(`last_used_step = ${Math.trunc(e.lastUsedStep)}`);
    lines.push(`recovery_hashes = [${e.recoveryHashes.map(tomlString).join(", ")}]`);
    lines.push(`created_at = ${tomlString(e.createdAt)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function tomlString(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("TOML string values must not contain control characters");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
