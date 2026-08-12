const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 60;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function setSharedResponseCacheHeaders(res, ttlMs) {
  const sharedTtlSeconds = Math.ceil(
    positiveNumber(ttlMs, DEFAULT_TTL_MS) / 1000,
  );
  const staleWhileRevalidateSeconds = Math.min(
    DEFAULT_STALE_WHILE_REVALIDATE_SECONDS,
    sharedTtlSeconds,
  );

  res.set(
    'Cache-Control',
    // Browser selalu revalidate; CDN Vercel boleh berbagi respons antar
    // instance selama s-maxage. Ini menghindari cache stale per-browser saat
    // katalog berubah tanpa mengorbankan shared caching.
    `public, max-age=0, s-maxage=${sharedTtlSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
  );
  res.set('CDN-Cache-Control', `public, max-age=${sharedTtlSeconds}`);
  res.set(
    'Vercel-CDN-Cache-Control',
    `public, max-age=${sharedTtlSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
  );
}

function setPrivateNoStoreHeaders(req, res, next) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = { setPrivateNoStoreHeaders, setSharedResponseCacheHeaders };
