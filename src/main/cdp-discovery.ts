const CDP_DEFAULT_PORT = 9222;
const CDP_PORT_RANGE_END = 9232;
const CDP_PROBE_TIMEOUT_MS = 400;

export function getCdpPort(): number {
  const fromEnv = process.env.FLMUX_CDP_PORT;
  if (fromEnv) {
    const port = Number(fromEnv);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }

  return CDP_DEFAULT_PORT;
}

export function getCdpBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function probeCdpPort(): Promise<string | null> {
  const fromEnv = process.env.FLMUX_CDP_PORT;
  if (fromEnv) {
    const port = Number(fromEnv);
    if (Number.isFinite(port) && port > 0) {
      const base = getCdpBaseUrl(port);
      if (await isCdpReachable(base)) {
        return base;
      }
    }
  }

  for (let port = CDP_DEFAULT_PORT; port <= CDP_PORT_RANGE_END; port += 1) {
    const base = getCdpBaseUrl(port);
    if (await isCdpReachable(base)) {
      return base;
    }
  }

  return null;
}

async function isCdpReachable(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CDP_PROBE_TIMEOUT_MS);
    const response = await fetch(`${baseUrl}/json/version`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}
