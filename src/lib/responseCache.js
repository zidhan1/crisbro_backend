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

// Untuk respons di BELAKANG autentikasi yang tetap layak di-cache browser.
//
// Shared cache tidak boleh dipakai di sini: cookie sesi bukan bagian dari cache
// key di edge secara default, sehingga respons milik sesi yang sudah login
// berpotensi dilayani ke permintaan anonim pada path yang sama.
//
// Menyetel Cache-Control saja TIDAK cukup. CDN-Cache-Control dan
// Vercel-CDN-Cache-Control lebih diprioritaskan oleh edge daripada
// Cache-Control, jadi keduanya disetel no-store secara eksplisit -- bukan
// sekadar dibiarkan kosong -- supaya perintah "jangan simpan di shared cache"
// tetap berlaku walaupun suatu saat ada middleware lain yang mengisinya.
function setPrivateResponseCacheHeaders(res, ttlMs) {
  const maxAgeSeconds = Math.ceil(positiveNumber(ttlMs, DEFAULT_TTL_MS) / 1000);

  res.set('Cache-Control', `private, max-age=${maxAgeSeconds}`);
  res.set('CDN-Cache-Control', 'private, no-store');
  res.set('Vercel-CDN-Cache-Control', 'private, no-store');
  // Pragma: no-cache dari default global membuat sebagian cache mengabaikan
  // max-age privat di atas, sehingga tujuan caching per-browser tidak tercapai.
  if (typeof res.removeHeader === 'function') res.removeHeader('Pragma');
}

function setPrivateNoStoreHeaders(req, res, next) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = {
  setPrivateNoStoreHeaders,
  setPrivateResponseCacheHeaders,
  setSharedResponseCacheHeaders,
};
