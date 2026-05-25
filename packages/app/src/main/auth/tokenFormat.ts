import { createHash, randomBytes } from "node:crypto";

interface GeneratedToken {
  id: string;
  value: string;
  hash: string;
  prefix: string;
}

export function generateToken(): GeneratedToken {
  const value = randomBytes(32).toString("hex");
  return {
    id: `tok_${randomBytes(8).toString("hex")}`,
    value,
    hash: hashToken(value),
    prefix: value.slice(0, 8)
  };
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable random WebAuthn user handle (base64url-encoded 64 random bytes).
 * Opaque, non-PII, never reassigned — decoupled from the mutable username. */
export function generateUserHandle(): string {
  return randomBytes(64).toString("base64url");
}
