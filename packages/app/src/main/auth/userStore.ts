import { existsSync, readFileSync } from "node:fs";

export type AllowPaneKinds = "*" | readonly string[];

/**
 * Read/write/call glob ACL on shell paths. The same `isPathAllowed`
 * gates both HTTP `/api/model/path/*` and the cap path (`sessionImpl`)
 * — WS is NOT a bypass. Only desktop preload skips it (no web-mode
 * authorizer = single trusted local user). Live WS events are
 * `read`-filtered separately (eventAclPath.ts).
 *
 * Glob subset: literals, `*` (matches any chars within one segment),
 * `**` (matches zero or more segments). Absent `allow_paths` or value
 * `"*"` means "all paths permitted".
 */
export type AllowPathsConfig =
  | "*"
  | {
      read?: readonly string[];
      write?: readonly string[];
      call?: readonly string[];
    };

export interface FlmuxUser {
  name: string;
  allowPaneKinds: AllowPaneKinds;
  allowPaths: AllowPathsConfig;
}

export interface UserStore {
  getUser(name: string): FlmuxUser | null;
  listUsers(): FlmuxUser[];
}

export function createUserStore(filePath: string): UserStore {
  function load(): Map<string, FlmuxUser> {
    if (!existsSync(filePath)) {
      return new Map();
    }

    const raw = readFileSync(filePath, "utf8");
    const parsed = Bun.TOML.parse(raw) as { users?: Array<Record<string, unknown>> };
    const users = (parsed.users ?? []).map(parseUser);

    const byName = new Map<string, FlmuxUser>();
    for (const user of users) {
      if (byName.has(user.name)) {
        throw new Error(`users.toml: duplicate user name '${user.name}'`);
      }
      byName.set(user.name, user);
    }
    return byName;
  }

  return {
    getUser(name) {
      return load().get(name) ?? null;
    },
    listUsers() {
      return [...load().values()];
    }
  };
}

function parseUser(raw: Record<string, unknown>): FlmuxUser {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    throw new Error("users.toml: user.name is required");
  }

  return {
    name,
    allowPaneKinds: parseAllowPaneKinds(raw.allow_pane_kinds, name),
    allowPaths: parseAllowPaths(raw.allow_paths, name)
  };
}

function parseAllowPaneKinds(raw: unknown, userName: string): AllowPaneKinds {
  if (raw === "*") {
    return "*";
  }

  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
    return [...(raw as string[])];
  }

  throw new Error(`users.toml: user '${userName}' has invalid allow_pane_kinds`);
}

function parseAllowPaths(raw: unknown, userName: string): AllowPathsConfig {
  // Absent → allow-all. Explicit "*" → same. Otherwise each method key
  // (read/write/call) is a list of glob patterns; missing keys mean no
  // access for that method.
  if (raw === undefined || raw === null || raw === "*") {
    return "*";
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const table = raw as Record<string, unknown>;
    const result: { read?: readonly string[]; write?: readonly string[]; call?: readonly string[] } = {};
    for (const method of ["read", "write", "call"] as const) {
      const value = table[method];
      if (value === undefined) {
        continue;
      }
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw new Error(
          `users.toml: user '${userName}' has invalid allow_paths.${method} (expected array of glob strings)`
        );
      }
      result[method] = [...(value as string[])];
    }
    return result;
  }

  throw new Error(`users.toml: user '${userName}' has invalid allow_paths`);
}
