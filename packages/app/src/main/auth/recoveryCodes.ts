import { randomBytes } from "node:crypto";
import { hashToken } from "./tokenFormat";

// Crockford base32 (no I/L/O/U) — human-typeable, ambiguity-resistant.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 20; // 20 × 5 bits = 100 bits
const GROUP = 5;

function oneCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let out = "";
  for (let i = 0; i < CODE_CHARS; i++) {
    out += ALPHABET[bytes[i]! & 31];
    if ((i + 1) % GROUP === 0 && i + 1 < CODE_CHARS) out += "-";
  }
  return out;
}

/** Canonicalize a user-typed recovery code: drop separators/whitespace,
 * uppercase, fold Crockford look-alikes (I/L→1, O→0). Hash + compare both use
 * this, so formatting/typo-prone chars don't reject a valid code. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[ILO]/g, (c) => (c === "O" ? "0" : "1"));
}

/** N single-use recovery codes (≥100-bit Crockford, grouped) + their sha256
 * hashes for at-rest storage. Plaintext is shown once at enroll, never stored. */
export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, oneCode);
  return { codes, hashes: codes.map((c) => hashToken(normalizeRecoveryCode(c))) };
}
