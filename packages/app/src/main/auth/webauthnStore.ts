import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

/** A registered passkey for a user. `publicKey` is the COSE public key
 * base64url-encoded (not secret — integrity matters, guarded by enrollment
 * authz). `signCount` is the authenticator's last-seen counter for clone
 * detection. `needsReview` flags a suspected clone (signCount regression) for
 * admin attention; such a credential is rejected at authentication. */
export interface FlmuxPasskeyCredential {
  user: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: AuthenticatorTransportFuture[];
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  needsReview?: boolean;
}

export interface WebauthnStore {
  listForUser(user: string): FlmuxPasskeyCredential[];
  findByCredentialId(credentialId: string): FlmuxPasskeyCredential | null;
  add(credential: FlmuxPasskeyCredential): void;
  /** Update signCount + lastUsedAt after a successful authentication. */
  updateUsage(credentialId: string, signCount: number, usedAt: string): void;
  /** Mark a credential as a suspected clone (admin review). */
  flagNeedsReview(credentialId: string): void;
  removeByCredentialId(credentialId: string): boolean;
}

export function createWebauthnStore(filePath: string): WebauthnStore {
  function load(): Map<string, FlmuxPasskeyCredential> {
    const byId = new Map<string, FlmuxPasskeyCredential>();
    if (!existsSync(filePath)) return byId;
    const raw = readFileSync(filePath, "utf8");
    const parsed = Bun.TOML.parse(raw) as { credentials?: Array<Record<string, unknown>> };
    for (const record of parsed.credentials ?? []) {
      const cred = parseCredential(record);
      if (byId.has(cred.credentialId)) {
        throw new Error(`webauthn.toml: duplicate credential id '${cred.credentialId}'`);
      }
      byId.set(cred.credentialId, cred);
    }
    return byId;
  }

  function persist(byId: Map<string, FlmuxPasskeyCredential>) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, stringifyCredentials([...byId.values()]), "utf8");
    renameSync(tmpPath, filePath);
  }

  return {
    listForUser(user) {
      return [...load().values()].filter((c) => c.user === user);
    },
    findByCredentialId(credentialId) {
      return load().get(credentialId) ?? null;
    },
    add(credential) {
      const byId = load();
      if (byId.has(credential.credentialId)) {
        throw new Error(`Credential '${credential.credentialId}' already registered`);
      }
      byId.set(credential.credentialId, credential);
      persist(byId);
    },
    updateUsage(credentialId, signCount, usedAt) {
      const byId = load();
      const cred = byId.get(credentialId);
      if (!cred) return;
      cred.signCount = signCount;
      cred.lastUsedAt = usedAt;
      persist(byId);
    },
    flagNeedsReview(credentialId) {
      const byId = load();
      const cred = byId.get(credentialId);
      if (!cred) return;
      cred.needsReview = true;
      persist(byId);
    },
    removeByCredentialId(credentialId) {
      const byId = load();
      if (!byId.delete(credentialId)) return false;
      persist(byId);
      return true;
    }
  };
}

function parseCredential(raw: Record<string, unknown>): FlmuxPasskeyCredential {
  const transports = Array.isArray(raw.transports)
    ? (raw.transports.filter((t) => typeof t === "string") as AuthenticatorTransportFuture[])
    : [];
  return {
    user: requireString(raw.user, "user"),
    credentialId: requireString(raw.credential_id, "credential_id"),
    publicKey: requireString(raw.public_key, "public_key"),
    signCount: typeof raw.sign_count === "number" ? raw.sign_count : 0,
    transports,
    label: typeof raw.label === "string" ? raw.label : "passkey",
    createdAt: requireString(raw.created_at, "created_at"),
    lastUsedAt: typeof raw.last_used_at === "string" ? raw.last_used_at : undefined,
    needsReview: raw.needs_review === true ? true : undefined
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`webauthn.toml: field '${field}' must be a non-empty string`);
  }
  return value;
}

function stringifyCredentials(credentials: readonly FlmuxPasskeyCredential[]): string {
  const lines = [
    "# webauthn.toml — passkey credentials, managed by flmux.",
    "# Do not edit by hand. public_key is a COSE key (base64url); not secret.",
    ""
  ];
  for (const c of credentials) {
    lines.push("[[credentials]]");
    lines.push(`user = ${tomlString(c.user)}`);
    lines.push(`credential_id = ${tomlString(c.credentialId)}`);
    lines.push(`public_key = ${tomlString(c.publicKey)}`);
    lines.push(`sign_count = ${Math.trunc(c.signCount)}`);
    lines.push(`transports = [${c.transports.map(tomlString).join(", ")}]`);
    lines.push(`label = ${tomlString(c.label)}`);
    lines.push(`created_at = ${tomlString(c.createdAt)}`);
    if (c.lastUsedAt !== undefined) lines.push(`last_used_at = ${tomlString(c.lastUsedAt)}`);
    if (c.needsReview) lines.push(`needs_review = true`);
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

/** Ceremony challenge bound to a short-lived temp cookie. Single process, so
 * in-memory is fine (restart aborts in-flight ceremonies — acceptable). */
export interface ChallengeRecord {
  challenge: string;
  /** "register" challenges carry the target user; "authenticate" don't. */
  kind: "register" | "authenticate";
  user?: string;
  expiresAt: number;
}

export interface ChallengeStore {
  /** Create a challenge entry, returning its opaque ceremony id (temp-cookie
   * value). */
  put(record: Omit<ChallengeRecord, "expiresAt">): string;
  /** Single-use: returns + deletes the record. Null if missing/expired. */
  take(id: string): ChallengeRecord | null;
}

/** In-memory challenge store with a hard size cap + active TTL eviction.
 * Per-IP rate limiting alone is insufficient — an unauthenticated options
 * endpoint could allocate up to RATE_LIMIT_MAX challenges per IP per window
 * (memory DoS). Cap + sweep bounds the footprint. */
export function createChallengeStore(options: {
  ttlMs?: number;
  maxEntries?: number;
  sweepMs?: number;
} = {}): ChallengeStore & { dispose(): void } {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 5_000;
  const sweepMs = options.sweepMs ?? 60_000;
  const entries = new Map<string, ChallengeRecord>();

  function sweep() {
    const now = Date.now();
    for (const [id, rec] of entries) {
      if (rec.expiresAt <= now) entries.delete(id);
    }
  }

  const timer = setInterval(sweep, sweepMs);
  // Don't keep the event loop alive for the sweeper alone.
  (timer as { unref?(): void }).unref?.();

  return {
    put(record) {
      // Reject new challenges past the cap rather than evict live ones —
      // bounds memory without letting a flood invalidate honest ceremonies.
      if (entries.size >= maxEntries) {
        sweep();
        if (entries.size >= maxEntries) {
          throw new Error("challenge store full");
        }
      }
      const id = randomBytes(18).toString("base64url");
      entries.set(id, { ...record, expiresAt: Date.now() + ttlMs });
      return id;
    },
    take(id) {
      const rec = entries.get(id);
      if (!rec) return null;
      entries.delete(id);
      if (rec.expiresAt <= Date.now()) return null;
      return rec;
    },
    dispose() {
      clearInterval(timer);
    }
  };
}
