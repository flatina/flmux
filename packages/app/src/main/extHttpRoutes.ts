import type { ExtensionHttpRoute, ExtensionServerDefinition } from "@flmux/extension-api";

/** A declared route resolved with its owning extension id + data dir. */
export interface ResolvedExtHttpRoute extends ExtensionHttpRoute {
  extId: string;
  dataDir: string;
}

const EXT_ID = /^[A-Za-z0-9._-]+$/;
// Leading "/", ≥1 non-slash segment char; no `:`/`*`/`%`/query/whitespace.
const EXT_HTTP_PATH = /^\/[A-Za-z0-9._-][A-Za-z0-9._\-/]*$/;

function isValidRoute(route: ExtensionHttpRoute): boolean {
  return (
    (route.method === "GET" || route.method === "POST") &&
    // public is GET-only — a public POST would be an unauthenticated CSRF-free mutation.
    (route.auth === "session" || (route.auth === "public" && route.method === "GET")) &&
    typeof route.path === "string" &&
    EXT_HTTP_PATH.test(route.path) &&
    !route.path.includes("..") &&
    !route.path.includes("//")
  );
}

/** Flatten each loaded server def's `httpRoutes` into resolved entries. Skips
 *  (with a warning) unsafe extension ids, extensions without a data dir, and
 *  invalid or duplicate `{method path}` routes — never throws. */
export function collectExtHttpRoutes(
  servers: Map<string, ExtensionServerDefinition>,
  resolveDataDir: (extId: string) => string | null
): ResolvedExtHttpRoute[] {
  const out: ResolvedExtHttpRoute[] = [];
  for (const [extId, def] of servers) {
    if (!EXT_ID.test(extId) || extId === "." || extId === "..") continue;
    if (!def.httpRoutes?.length) continue;
    const dataDir = resolveDataDir(extId);
    if (!dataDir) continue;
    const seen = new Set<string>();
    for (const route of def.httpRoutes) {
      const key = `${route.method} ${route.path}`;
      if (!isValidRoute(route) || seen.has(key)) {
        console.warn(`[flmux] extension '${extId}' httpRoute skipped (invalid/dup): ${key}`);
        continue;
      }
      seen.add(key);
      out.push({ ...route, extId, dataDir });
    }
  }
  return out;
}
