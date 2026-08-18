const rateLimit = require('express-rate-limit');
const prisma = require('./prisma');

// Penyimpan hitungan rate limit di Postgres.
//
// MemoryStore bawaan express-rate-limit tidak memadai di sini: backend berjalan
// sebagai serverless function di Vercel, dan tiap instance punya memorinya
// sendiri. Penyerang yang requestnya tersebar ke banyak instance akan mendapat
// jatah sebanyak jumlah instance, dan hitungan hilang setiap cold start.
// Menyimpannya di database membuat batas berlaku menyeluruh.
class PrismaRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const storeKey = `${this.prefix}:${key}`;
    const expiresAt = new Date(Date.now() + this.windowMs);

    // Satu perjalanan ke database, dan atomik: jendela yang sudah lewat
    // di-reset ke 1, jendela berjalan ditambah 1.
    const [row] = await prisma.$queryRaw`
      INSERT INTO "RateLimitCounter" ("key", "hits", "expires_at")
      VALUES (${storeKey}, 1, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE
          WHEN "RateLimitCounter"."expires_at" <= NOW() THEN 1
          ELSE "RateLimitCounter"."hits" + 1
        END,
        "expires_at" = CASE
          WHEN "RateLimitCounter"."expires_at" <= NOW() THEN ${expiresAt}
          ELSE "RateLimitCounter"."expires_at"
        END
      RETURNING "hits", "expires_at"
    `;

    return { totalHits: Number(row.hits), resetTime: row.expires_at };
  }

  async decrement(key) {
    await prisma.$executeRaw`
      UPDATE "RateLimitCounter"
      SET "hits" = GREATEST(0, "hits" - 1)
      WHERE "key" = ${`${this.prefix}:${key}`}
    `;
  }

  async resetKey(key) {
    await prisma.$executeRaw`
      DELETE FROM "RateLimitCounter" WHERE "key" = ${`${this.prefix}:${key}`}
    `;
  }
}

function tooManyRequests(message) {
  return (req, res) => res.status(429).json({ message });
}

// Batas ketat untuk endpoint autentikasi. Endpoint inilah yang dipakai untuk
// menebak password maupun memetakan nomor telepon yang terdaftar, sehingga
// jatahnya jauh lebih kecil daripada endpoint biasa.
function createDedicatedLimiter({ prefix, windowMs, max, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new PrismaRateLimitStore(prefix),
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: tooManyRequests(message),
  });
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function shouldSkipGlobalLimiter(req) {
  // Endpoint autentikasi memiliki limiter IP/akun yang lebih ketat di route
  // masing-masing. Jangan ikut menghabiskan kuota API umum: trafik dashboard
  // atau NAT/proxy bersama tidak boleh mengunci pintu login semua pengguna.
  return (
    req.path.startsWith('/api/cron/') ||
    ['/api/login', '/api/register', '/api/activate'].includes(req.path)
  );
}

// Per alamat IP. Menahan satu sumber yang membombardir endpoint autentikasi.
const authIpLimiter = createDedicatedLimiter({
  prefix: 'auth-ip',
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  message:
    'Terlalu banyak percobaan. Silakan coba lagi dalam beberapa menit.',
});

// Per nomor telepon. Tanpa ini, penyerang yang memakai banyak IP tetap bisa
// menggempur satu akun. Ambangnya lebih longgar daripada batas IP supaya tidak
// gampang dipakai mengunci akun orang lain.
const loginAccountLimiter = createDedicatedLimiter({
  prefix: 'login-account',
  windowMs: FIFTEEN_MINUTES,
  max: 20,
  message:
    'Terlalu banyak percobaan login untuk nomor ini. Silakan coba lagi nanti.',
  keyGenerator: (req) => String(req.body?.phone_number ?? 'tanpa-nomor'),
});

function customerTargetKey(req) {
  const customerId = Number(req.params?.id);
  return Number.isInteger(customerId) && customerId > 0
    ? `customer:${customerId}`
    : 'customer:invalid';
}

// Endpoint ini menghasilkan email. Kuota berbasis customer (bukan admin/IP)
// mencegah beberapa akun staf atau beberapa instance aplikasi bersama-sama
// membanjiri alamat email customer yang sama.
const resendActivationTargetLimiter = createDedicatedLimiter({
  prefix: 'admin-resend-activation',
  windowMs: FIFTEEN_MINUTES,
  max: 3,
  message:
    'Terlalu banyak pengiriman aktivasi untuk customer ini. Silakan coba lagi nanti.',
  keyGenerator: customerTargetKey,
});

// Retry sinkronisasi memanggil API eksternal. Prefix terpisah memastikan
// pengiriman email dan retry sync tidak saling menghabiskan kuota.
const runchiseSyncTargetLimiter = createDedicatedLimiter({
  prefix: 'admin-runchise-sync',
  windowMs: FIFTEEN_MINUTES,
  max: 5,
  message:
    'Terlalu banyak percobaan sinkronisasi untuk customer ini. Silakan coba lagi nanti.',
  keyGenerator: customerTargetKey,
});

// Batas umum seluruh API. Sengaja longgar: tujuannya menahan penyalahgunaan
// besar-besaran, bukan mengganggu pemakaian dashboard yang wajar.
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PrismaRateLimitStore('global'),
  handler: tooManyRequests('Terlalu banyak permintaan. Coba lagi sebentar lagi.'),
  // Endpoint cron dipanggil penjadwal Vercel dan sudah dijaga CRON_SECRET.
  skip: shouldSkipGlobalLimiter,
});

// Menghapus baris yang jendelanya sudah lewat agar tabel tidak menumpuk.
async function pruneRateLimitCounters() {
  return prisma.$executeRaw`
    DELETE FROM "RateLimitCounter" WHERE "expires_at" <= NOW()
  `;
}

module.exports = {
  authIpLimiter,
  globalLimiter,
  loginAccountLimiter,
  pruneRateLimitCounters,
  resendActivationTargetLimiter,
  runchiseSyncTargetLimiter,
  shouldSkipGlobalLimiter,
};
