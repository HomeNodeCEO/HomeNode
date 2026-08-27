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

export function createInFlightRequestCache<T>() {
  const requests = new Map<string, Promise<T>>();

  return {
    load(key: string, request: () => Promise<T>): Promise<T> {
      const existing = requests.get(key);
      if (existing) return existing;

      const promise = request().finally(() => {
        if (requests.get(key) === promise) requests.delete(key);
      });
      requests.set(key, promise);
      return promise;
    },
    clear() {
      requests.clear();
    },
  };
}
