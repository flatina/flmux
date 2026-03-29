const moduleCache = new Map<string, Promise<unknown>>();

export async function loadExtensionModule<T>(
  key: string,
  sourceUrl: string,
  loadSource: () => Promise<string>
): Promise<T> {
  const cached = moduleCache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }

  const pending = (async () => {
    const source = await loadSource();
    const sourceWithUrl = `${source}\n//# sourceURL=${sourceUrl}`;
    const blob = new Blob([sourceWithUrl], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(/* @vite-ignore */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })().catch((error) => {
    moduleCache.delete(key);
    throw error;
  });

  moduleCache.set(key, pending);
  return pending as Promise<T>;
}
