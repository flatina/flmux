import type { FlmuxUser } from "./userStore";
import type { FlmuxIssuedToken } from "./tokenStore";

export function stringifyUsersToml(users: readonly FlmuxUser[]): string {
  const lines = [
    "# users.toml — static user config for flmux web mode.",
    "# allow_pane_kinds = \"*\" grants every pane kind; otherwise list them explicitly.",
    ""
  ];

  for (const user of users) {
    lines.push("[[users]]");
    lines.push(`name = ${tomlString(user.name)}`);
    lines.push(`allow_pane_kinds = ${renderAllowPaneKinds(user.allowPaneKinds)}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function stringifyTokensToml(tokens: readonly FlmuxIssuedToken[]): string {
  const lines = [
    "# users.tokens.toml — managed by flmux.",
    "# Do not edit by hand. Use `flmux tokens issue` / `flmux tokens revoke`.",
    ""
  ];

  for (const token of tokens) {
    lines.push("[[tokens]]");
    lines.push(`id = ${tomlString(token.id)}`);
    lines.push(`user = ${tomlString(token.user)}`);
    lines.push(`token_hash = ${tomlString(token.tokenHash)}`);
    lines.push(`token_prefix = ${tomlString(token.tokenPrefix)}`);
    lines.push(`created_at = ${tomlString(token.createdAt)}`);
    if (token.label !== undefined) {
      lines.push(`label = ${tomlString(token.label)}`);
    }
    if (token.expiresAt !== undefined) {
      lines.push(`expires_at = ${tomlString(token.expiresAt)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderAllowPaneKinds(value: FlmuxUser["allowPaneKinds"]): string {
  if (value === "*") {
    return tomlString("*");
  }

  if (value.length === 0) {
    return "[]";
  }

  return `[${value.map(tomlString).join(", ")}]`;
}

function tomlString(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("TOML string values must not contain control characters (including CR/LF)");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
