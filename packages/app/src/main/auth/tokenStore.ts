import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringifyTokensToml } from "./tomlWriter";

/** Token namespace. `machine` = long-lived bearer (CLI/automation). `session`
 * = passkey-minted browser session. `enrollment` = single-use short-TTL grant
 * that authorizes adding a first passkey — MUST NOT resolve to a session
 * (authorize() filters on kind). Absent in TOML → `machine` (back-compat). */
export type FlmuxTokenKind = "machine" | "session" | "enrollment";

export interface FlmuxIssuedToken {
  id: string;
  user: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  kind: FlmuxTokenKind;
  label?: string;
  expiresAt?: string;
}

export interface TokenStore {
  findByHash(tokenHash: string): FlmuxIssuedToken | null;
  findById(tokenId: string): FlmuxIssuedToken | null;
  list(): FlmuxIssuedToken[];
  append(token: FlmuxIssuedToken): void;
  /** Atomic consume: returns true only for the caller that removed it. A
   * concurrent second removeById on the same id returns false — the basis
   * for single-use enrollment-token "winner" semantics. */
  removeById(tokenId: string): boolean;
  /** Drop expired tokens. Call at startup / on a timer — NEVER per request
   * (findByHash is the authorize hot path). Returns the count removed. */
  prune(now?: number): number;
  /** Re-read the file into the in-memory index. For the tokens.toml fs.watch
   * path so the running server sees external CLI revokes. */
  reload(): void;
}

interface TokenMaps {
  byId: Map<string, FlmuxIssuedToken>;
  byHash: Map<string, FlmuxIssuedToken>;
}

export function createTokenStore(filePath: string): TokenStore {
  // In-memory index: authorize() reads this, not the file — no per-request
  // TOML parse. Staleness is detected by a cheap mtime stat (one syscall, no
  // parse), so an external CLI revoke is seen on the very next request without
  // re-parsing on every request. Local writes refresh the cache + signature.
  let cache: TokenMaps | null = null;
  let cacheSig = "";

  function fileSignature(): string {
    try {
      const st = statSync(filePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return ""; // absent file
    }
  }

  function readFromDisk(): TokenMaps {
    const byId = new Map<string, FlmuxIssuedToken>();
    const byHash = new Map<string, FlmuxIssuedToken>();

    if (!existsSync(filePath)) {
      return { byId, byHash };
    }

    const raw = readFileSync(filePath, "utf8");
    const parsed = Bun.TOML.parse(raw) as { tokens?: Array<Record<string, unknown>> };
    for (const record of parsed.tokens ?? []) {
      const token = parseToken(record);
      if (byId.has(token.id)) {
        throw new Error(`users.tokens.toml: duplicate token id '${token.id}'`);
      }
      if (byHash.has(token.tokenHash)) {
        throw new Error(`users.tokens.toml: duplicate token hash for id '${token.id}'`);
      }
      byId.set(token.id, token);
      byHash.set(token.tokenHash, token);
    }

    return { byId, byHash };
  }

  function maps(): TokenMaps {
    const sig = fileSignature();
    if (!cache || sig !== cacheSig) {
      cache = readFromDisk();
      cacheSig = sig;
    }
    return cache;
  }

  function persist(next: TokenMaps) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, stringifyTokensToml([...next.byId.values()]), "utf8");
    renameSync(tmpPath, filePath);
    cache = next;
    cacheSig = fileSignature();
  }

  return {
    findByHash(tokenHash) {
      return maps().byHash.get(tokenHash) ?? null;
    },
    findById(tokenId) {
      return maps().byId.get(tokenId) ?? null;
    },
    list() {
      return [...maps().byId.values()];
    },
    append(token) {
      // Re-read first: a concurrent CLI process may have written since our
      // last cache fill (append is rare, off the hot path).
      const next = readFromDisk();
      if (next.byId.has(token.id)) {
        throw new Error(`Token id '${token.id}' already exists`);
      }
      if (next.byHash.has(token.tokenHash)) {
        throw new Error(`Token with the same hash already exists (id '${token.id}')`);
      }
      next.byId.set(token.id, token);
      next.byHash.set(token.tokenHash, token);
      persist(next);
    },
    removeById(tokenId) {
      const next = readFromDisk();
      const existing = next.byId.get(tokenId);
      if (!existing) {
        cache = next;
        return false;
      }
      next.byId.delete(tokenId);
      next.byHash.delete(existing.tokenHash);
      persist(next);
      return true;
    },
    prune(now = Date.now()) {
      const next = readFromDisk();
      let removed = 0;
      for (const token of [...next.byId.values()]) {
        if (!token.expiresAt) continue;
        const expiryMs = Date.parse(token.expiresAt);
        if (Number.isNaN(expiryMs) || expiryMs <= now) {
          next.byId.delete(token.id);
          next.byHash.delete(token.tokenHash);
          removed += 1;
        }
      }
      if (removed > 0) persist(next);
      else cache = next;
      return removed;
    },
    reload() {
      cache = readFromDisk();
      cacheSig = fileSignature();
    }
  };
}

function parseToken(raw: Record<string, unknown>): FlmuxIssuedToken {
  return {
    id: requireString(raw.id, "id"),
    user: requireString(raw.user, "user"),
    tokenHash: requireString(raw.token_hash, "token_hash"),
    tokenPrefix: requireString(raw.token_prefix, "token_prefix"),
    createdAt: requireString(raw.created_at, "created_at"),
    kind: parseKind(raw.kind),
    label: typeof raw.label === "string" ? raw.label : undefined,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : undefined
  };
}

function parseKind(raw: unknown): FlmuxTokenKind {
  if (raw === "session" || raw === "enrollment" || raw === "machine") return raw;
  if (raw === undefined) return "machine";
  throw new Error(`users.tokens.toml: invalid token kind '${String(raw)}'`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`users.tokens.toml: field '${field}' must be a non-empty string`);
  }
  return value;
}
