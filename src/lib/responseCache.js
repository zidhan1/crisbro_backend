const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_BROWSER_TTL_SECONDS = 60;
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 60;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function createResponseCache(defaultTtlMs, options = {}) {
  const store = new Map();
  const normalizedDefaultTtlMs = positiveNumber(defaultTtlMs, DEFAULT_TTL_MS);
  const maxEntries = Math.max(
    1,
    Math.floor(positiveNumber(options.maxEntries, DEFAULT_MAX_ENTRIES)),
  );

  function removeExpired(now) {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;

      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }

      // Map mempertahankan insertion order. Memindahkan entry yang dibaca ke
      // belakang menjadikannya implementasi LRU sederhana dan deterministik.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key, value, ttlMs = normalizedDefaultTtlMs) {
      const now = Date.now();
      const normalizedTtlMs = positiveNumber(ttlMs, normalizedDefaultTtlMs);
      removeExpired(now);
      store.delete(key);

      while (store.size >= maxEntries) {
        const leastRecentlyUsedKey = store.keys().next().value;
        store.delete(leastRecentlyUsedKey);
      }

      store.set(key, {
        value,
        expiresAt: now + normalizedTtlMs,
      });
    },

    clear() {
      store.clear();
    },
  };
}

function setSharedResponseCacheHeaders(res, ttlMs) {
  const sharedTtlSeconds = Math.ceil(
    positiveNumber(ttlMs, DEFAULT_TTL_MS) / 1000,
  );
  const browserTtlSeconds = Math.min(
    DEFAULT_BROWSER_TTL_SECONDS,
    sharedTtlSeconds,
  );
  const staleWhileRevalidateSeconds = Math.min(
    DEFAULT_STALE_WHILE_REVALIDATE_SECONDS,
    sharedTtlSeconds,
  );

  res.set(
    'Cache-Control',
    `public, max-age=${browserTtlSeconds}, s-maxage=${sharedTtlSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
  );
}

module.exports = { createResponseCache, setSharedResponseCacheHeaders };
