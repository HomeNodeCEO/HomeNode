export function createTimedRequestCache<T>(ttlMs: number) {
  type CacheEntry = { createdAt: number; promise: Promise<T> };
  const entries = new Map<string, CacheEntry>();

  return {
    load(
      key: string,
      request: () => Promise<T>,
      { force = false, now = Date.now() } = {},
    ): Promise<T> {
      const existing = entries.get(key);
      if (!force && existing && now - existing.createdAt < ttlMs) {
        return existing.promise;
      }
      const promise = request().catch((error) => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
        throw error;
      });
      entries.set(key, { createdAt: now, promise });
      return promise;
    },
    clear() {
      entries.clear();
    },
  };
}
