import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringifyUsersToml } from "./tomlWriter";
import { validateDisplayName } from "./displayName";

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
  /** Human-facing label, auto-generated at signup (adjective-noun). Mutable
   * via the self-edit profile endpoint. Absent for pre-existing users → the
   * renderer falls back to `name`. */
  displayName: string | undefined;
  role: string | undefined;
  allowPaneKinds: AllowPaneKinds;
  /** Kinds blocked even when allowPaneKinds permits — lets a role grant `*`
   * minus a few (non-dev tiers = all but `terminal`). */
  denyPaneKinds: readonly string[];
  allowPaths: AllowPathsConfig;
  /** Filesystem grant for the agent sandbox (+ Phase-2 `/fs`), resolved by
   * `fsPolicy.ts` — NOT `allowPaths` (fail-open). `fsUnconfined` = full fs;
   * else `dirsRw`/`dirsRo` (templated, base-confined; empty = no access). */
  fsUnconfined: boolean;
  dirsRw: readonly string[];
  dirsRo: readonly string[];
}

export interface UserStore {
  getUser(name: string): FlmuxUser | null;
  getUserByHandle(handle: string): FlmuxUser | null;
  listUsers(): FlmuxUser[];
  /** Set a user's display name and rewrite users.toml atomically (tmp+rename).
   * Validates via `validateDisplayName`. Throws if the user is absent. */
  setDisplayName(name: string, displayName: string): FlmuxUser;
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
    const handles = new Set<string>();
    for (const user of users) {
      if (byName.has(user.name)) {
        throw new Error(`users.toml: duplicate user name '${user.name}'`);
      }
      byName.set(user.name, user);
      // Handles key per-user fs dirs; a duplicate would alias two users' workspaces.
      if (user.handle !== undefined) {
        if (handles.has(user.handle)) {
          throw new Error(`users.toml: duplicate handle '${user.handle}'`);
        }
        handles.add(user.handle);
      }
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
    },
    setDisplayName(name, displayName) {
      const validated = validateDisplayName(displayName);
      // Re-read first so a concurrent CLI write isn't clobbered.
      const byName = load();
      const existing = byName.get(name);
      if (!existing) {
        throw new Error(`users.toml: user '${name}' not found`);
      }
      const updated: FlmuxUser = { ...existing, displayName: validated };
      byName.set(name, updated);
      writeUsersFile(filePath, [...byName.values()]);
      return updated;
    }
  };
}

function writeUsersFile(filePath: string, users: readonly FlmuxUser[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, stringifyUsersToml(users), "utf8");
  renameSync(tmpPath, filePath);
}

// Org tiers. Only `dev` gets terminal + unconfined fs. `tech`/`user` are
// agent-sandboxed (no terminal); `tech` additionally writes shared skills.
// Unknown role with no explicit fields → parse error / no fs (fail-closed).
const OWN_WORKSPACE = "{flmux_users}/u/{handle}";
const SHARED_SKILLS = "{flmux_users}/shared_skills";
const SHARED_RW = "{flmux_users}/shared_rw";
interface RolePreset {
  allowPaneKinds: AllowPaneKinds;
  denyPaneKinds: readonly string[];
  fsUnconfined: boolean;
  dirsRw: readonly string[];
  dirsRo: readonly string[];
}
const ROLE_PRESETS: Record<string, RolePreset> = {
  dev: { allowPaneKinds: "*", denyPaneKinds: [], fsUnconfined: true, dirsRw: [], dirsRo: [] },
  tech: {
    allowPaneKinds: "*",
    denyPaneKinds: ["terminal"],
    fsUnconfined: false,
    dirsRw: [OWN_WORKSPACE, SHARED_SKILLS, SHARED_RW],
    dirsRo: []
  },
  user: {
    allowPaneKinds: "*",
    denyPaneKinds: ["terminal"],
    fsUnconfined: false,
    dirsRw: [OWN_WORKSPACE, SHARED_RW],
    dirsRo: []
  }
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
    throw new Error(`users.toml: user '${name}' needs allow_pane_kinds or a preset role (dev|tech|user)`);
  }
  const denyPaneKinds =
    raw.deny_pane_kinds !== undefined
      ? parseStringArray(raw.deny_pane_kinds, name, "deny_pane_kinds")
      : (preset?.denyPaneKinds ?? []);

  // base64url handle is a path component (`u/<handle>`); reject anything that
  // could escape (`/`, `.`, etc.) at load so a hand-edited handle can't.
  const handleRaw = typeof raw.handle === "string" && raw.handle.trim() ? raw.handle.trim() : undefined;
  if (handleRaw !== undefined && !/^[A-Za-z0-9_-]+$/.test(handleRaw)) {
    throw new Error(`users.toml: user '${name}' has invalid handle (expected base64url chars)`);
  }
  const displayName =
    typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : undefined;

  const fsUnconfined = typeof raw.fs_unconfined === "boolean" ? raw.fs_unconfined : (preset?.fsUnconfined ?? false);

  return {
    name,
    handle: handleRaw,
    displayName,
    role,
    allowPaneKinds,
    denyPaneKinds,
    allowPaths: parseAllowPaths(raw.allow_paths, name),
    fsUnconfined,
    dirsRw: raw.dirs_rw !== undefined ? parseStringArray(raw.dirs_rw, name, "dirs_rw") : (preset?.dirsRw ?? []),
    dirsRo: raw.dirs_ro !== undefined ? parseStringArray(raw.dirs_ro, name, "dirs_ro") : (preset?.dirsRo ?? [])
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
