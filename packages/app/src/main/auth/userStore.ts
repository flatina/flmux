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
  /** Stable random opaque id (base64url, ~64B) used as the WebAuthn user
   * handle. Independent of the mutable `name` so a rename never breaks
   * discoverable credentials. Absent for machine-only users (no passkeys). */
  handle: string | undefined;
  role: string | undefined;
  allowPaneKinds: AllowPaneKinds;
  /** Kinds blocked even when allowPaneKinds permits — lets a role grant `*`
   * minus a few (operator = all but `terminal`). */
  denyPaneKinds: readonly string[];
  allowPaths: AllowPathsConfig;
}

export interface UserStore {
  getUser(name: string): FlmuxUser | null;
  getUserByHandle(handle: string): FlmuxUser | null;
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
    getUserByHandle(handle) {
      for (const user of load().values()) {
        if (user.handle === handle) return user;
      }
      return null;
    },
    listUsers() {
      return [...load().values()];
    }
  };
}

// Role presets: developer/admin = full; operator = everything but terminal.
// `user` and other roles use explicit allow_pane_kinds (positive allowlist).
const ROLE_PRESETS: Record<string, { allowPaneKinds: AllowPaneKinds; denyPaneKinds: readonly string[] }> = {
  developer: { allowPaneKinds: "*", denyPaneKinds: [] },
  admin: { allowPaneKinds: "*", denyPaneKinds: [] },
  operator: { allowPaneKinds: "*", denyPaneKinds: ["terminal"] }
};

function parseUser(raw: Record<string, unknown>): FlmuxUser {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    throw new Error("users.toml: user.name is required");
  }

  const role = typeof raw.role === "string" ? raw.role.trim() : undefined;
  const preset = role ? ROLE_PRESETS[role] : undefined;
  const allowPaneKinds =
    raw.allow_pane_kinds !== undefined ? parseAllowPaneKinds(raw.allow_pane_kinds, name) : preset?.allowPaneKinds;
  if (allowPaneKinds === undefined) {
    throw new Error(`users.toml: user '${name}' needs allow_pane_kinds or a preset role (developer|operator|admin)`);
  }
  const denyPaneKinds =
    raw.deny_pane_kinds !== undefined
      ? parseStringArray(raw.deny_pane_kinds, name, "deny_pane_kinds")
      : (preset?.denyPaneKinds ?? []);

  const handle = typeof raw.handle === "string" && raw.handle.trim() ? raw.handle.trim() : undefined;

  return {
    name,
    handle,
    role,
    allowPaneKinds,
    denyPaneKinds,
    allowPaths: parseAllowPaths(raw.allow_paths, name)
  };
}

function parseStringArray(raw: unknown, userName: string, field: string): readonly string[] {
  if (Array.isArray(raw) && raw.every((e) => typeof e === "string")) {
    return [...(raw as string[])];
  }
  throw new Error(`users.toml: user '${userName}' has invalid ${field} (expected array of strings)`);
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
