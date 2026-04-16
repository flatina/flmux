import { existsSync, readFileSync } from "node:fs";

export type AllowPaneKinds = "*" | readonly string[];

export interface FlmuxUser {
  name: string;
  allowPaneKinds: AllowPaneKinds;
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
    allowPaneKinds: parseAllowPaneKinds(raw.allow_pane_kinds, name)
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
