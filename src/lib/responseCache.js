function createResponseCache(defaultTtlMs) {
  const store = new Map();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;

      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }

      return entry.value;
    },

    set(key, value, ttlMs = defaultTtlMs) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    },

    clear() {
      store.clear();
    },
  };
}

module.exports = { createResponseCache };
