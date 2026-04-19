/**
 * Minimatch-subset glob for `/api/model/path/*` ACL.
 *
 * Syntax:
 * - literal characters match exactly (path segments are `/`-separated).
 * - `*` matches any characters within a single segment (not `/`).
 * - `**` matches zero or more full segments, including none.
 *
 * Examples:
 * - "/status/**" matches "/status", "/status/app", "/status/app/title".
 * - "/panes/[any]/close" matches "/panes/pane.xyz/close" only.
 * - "/workspaces/ws.1/**" matches "/workspaces/ws.1" and anything beneath.
 *
 * Leading "/" is required on both pattern and path; match is anchored
 * (whole-path, not substring).
 */
export function matchPathGlob(pattern: string, path: string): boolean {
  const patternSegments = splitPath(pattern);
  const pathSegments = splitPath(path);
  return matchSegments(patternSegments, pathSegments);
}

/** Match against any of several patterns; returns true on the first hit. */
export function matchAnyPathGlob(patterns: readonly string[], path: string): boolean {
  for (const pattern of patterns) {
    if (matchPathGlob(pattern, path)) return true;
  }
  return false;
}

function splitPath(raw: string): string[] {
  // Strip leading slash so the segment array doesn't carry an empty head.
  const trimmed = raw.startsWith("/") ? raw.slice(1) : raw;
  if (trimmed === "") return [];
  return trimmed.split("/");
}

function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length === 0) {
    return target.length === 0;
  }
  const [head, ...rest] = pattern;
  if (head === "**") {
    if (rest.length === 0) return true;
    // Try matching the rest against every possible tail of `target`.
    for (let i = 0; i <= target.length; i += 1) {
      if (matchSegments(rest, target.slice(i))) return true;
    }
    return false;
  }
  if (target.length === 0) {
    return false;
  }
  if (!matchSegment(head, target[0]!)) {
    return false;
  }
  return matchSegments(rest, target.slice(1));
}

function matchSegment(pattern: string, segment: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(segment);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
