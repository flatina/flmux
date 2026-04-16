import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringifyTokensToml } from "./tomlWriter";

export interface FlmuxIssuedToken {
  id: string;
  user: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  label?: string;
  expiresAt?: string;
}

export interface TokenStore {
  findByHash(tokenHash: string): FlmuxIssuedToken | null;
  findById(tokenId: string): FlmuxIssuedToken | null;
  list(): FlmuxIssuedToken[];
  append(token: FlmuxIssuedToken): void;
  removeById(tokenId: string): boolean;
}

interface TokenMaps {
  byId: Map<string, FlmuxIssuedToken>;
  byHash: Map<string, FlmuxIssuedToken>;
}

export function createTokenStore(filePath: string): TokenStore {
  function load(): TokenMaps {
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

  function persist(maps: TokenMaps) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, stringifyTokensToml([...maps.byId.values()]), "utf8");
    renameSync(tmpPath, filePath);
  }

  return {
    findByHash(tokenHash) {
      return load().byHash.get(tokenHash) ?? null;
    },
    findById(tokenId) {
      return load().byId.get(tokenId) ?? null;
    },
    list() {
      return [...load().byId.values()];
    },
    append(token) {
      const maps = load();
      if (maps.byId.has(token.id)) {
        throw new Error(`Token id '${token.id}' already exists`);
      }
      if (maps.byHash.has(token.tokenHash)) {
        throw new Error(`Token with the same hash already exists (id '${token.id}')`);
      }
      maps.byId.set(token.id, token);
      maps.byHash.set(token.tokenHash, token);
      persist(maps);
    },
    removeById(tokenId) {
      const maps = load();
      const existing = maps.byId.get(tokenId);
      if (!existing) {
        return false;
      }
      maps.byId.delete(tokenId);
      maps.byHash.delete(existing.tokenHash);
      persist(maps);
      return true;
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
    label: typeof raw.label === "string" ? raw.label : undefined,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : undefined
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`users.tokens.toml: field '${field}' must be a non-empty string`);
  }
  return value;
}
