// FLMUX_HOST is a listen address, not always one a caller can dial. Two origins
// derive: `internal` for same-machine callers (wildcard → loopback) and `browser`
// for what a remote browser dials (publicOrigin, or a specific-IP bind). IPv4 /
// loopback only — an IPv6 literal would need URL bracketing.

// Range-checked octets (0–255) so a bad IP fails the guard, not app.listen.
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost";
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0";
}

/** Bare scheme://host:port (no trailing slash/path) so allowlist membership matches. */
export function normalizeOrigin(raw: string): string {
  return new URL(raw).origin;
}

/** Boot-time guard. Throws an operator-facing error on an unusable host config. */
export function assertHostPolicy(opts: { runtimeMode: string; host: string; publicOrigin: string | undefined }): void {
  const { runtimeMode, host, publicOrigin } = opts;
  // Validate here so a malformed publicOrigin fails fast, not as a post-bind throw.
  if (publicOrigin) {
    try {
      normalizeOrigin(publicOrigin);
    } catch {
      throw new Error(`[flmux] FLMUX_PUBLIC_ORIGIN='${publicOrigin}' is not a valid URL`);
    }
  }
  if (!isLoopbackHost(host) && !IPV4.test(host)) {
    throw new Error(
      `[flmux] FLMUX_HOST='${host}' is unsupported — use an IPv4 address or 127.0.0.1/localhost (IPv6 not supported)`
    );
  }
  if (runtimeMode === "desktop" && !isLoopbackHost(host)) {
    throw new Error(
      `[flmux] desktop mode cannot bind non-loopback host '${host}' — it serves unauthenticated, so FLMUX_HOST is web-only`
    );
  }
  if (runtimeMode === "web" && isWildcardHost(host) && !publicOrigin) {
    throw new Error(
      `[flmux] FLMUX_HOST=0.0.0.0 requires FLMUX_PUBLIC_ORIGIN (or bind a specific IP) so the browser gets a reachable origin`
    );
  }
}

export function internalOriginHost(host: string): string {
  return isWildcardHost(host) ? "127.0.0.1" : host;
}

/** Browser-facing origin: publicOrigin, else the bind host itself. */
export function resolveBrowserOrigin(opts: { host: string; port: number; publicOrigin: string | undefined }): string {
  const { host, port, publicOrigin } = opts;
  if (publicOrigin) return normalizeOrigin(publicOrigin);
  // Echo the bind host (incl. localhost); collapsing to 127.0.0.1 mismatches the page.
  return `http://${host}:${port}`;
}
