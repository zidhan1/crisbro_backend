const rateLimit = require('express-rate-limit');
const prisma = require('./prisma');
const { normalizePhone } = require('./phoneNumber');

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
  // Express menerima dua bentuk tergantung adapter/deployment: local mount
  // masih memuat prefix `/api`, sedangkan Vercel function sering sudah
  // menghapusnya sebelum meneruskan request ke app.
  const path = String(req.path || '').replace(/^\/api(?=\/|$)/, '') || '/';
  return (
    path.startsWith('/cron/') ||
    ['/login', '/register', '/activate'].includes(path)
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

// Kunci kuota per-akun WAJIB memakai identitas yang sama dengan yang dipakai
// login untuk mencari user. login() menormalisasi nomor lebih dulu
// (normalizePhone: buang non-digit, buang awalan 62/0) lalu mencocokkan
// seluruh variannya. Memakai nilai mentah dari body membuat "0812-3456-7890",
// "0812 3456 7890", dan "+62 812 3456 7890" menjadi tiga kunci berbeda untuk
// SATU akun yang sama, sehingga kuota per-akun praktis tak terbatas dan yang
// tersisa hanya batas per-IP -- justru serangan terdistribusi yang limiter ini
// dibuat untuk mencegah.
//
// Panjangnya dibatasi karena kunci ini menjadi PRIMARY KEY btree di tabel
// "RateLimitCounter": body login boleh sampai 100kb dan kunci sebesar itu
// ditolak PostgreSQL ("index row requires N bytes, maximum size is 8191"),
// yang membuat /login membalas 500 tanpa perlu autentikasi. Nomor sah yang
// sudah ternormalisasi hanya ~9-12 digit, jadi batas ini tidak pernah
// memotong input yang benar; input sampah cukup dikumpulkan ke satu ember.
const MAX_ACCOUNT_KEY_LENGTH = 24;

function loginAccountKey(req) {
  const normalized = normalizePhone(req.body?.phone_number);
  if (!normalized) return 'tanpa-nomor';
  return String(normalized).slice(0, MAX_ACCOUNT_KEY_LENGTH);
}

// Per nomor telepon. Tanpa ini, penyerang yang memakai banyak IP tetap bisa
// menggempur satu akun. Ambangnya lebih longgar daripada batas IP supaya tidak
// gampang dipakai mengunci akun orang lain.
const loginAccountLimiter = createDedicatedLimiter({
  prefix: 'login-account',
  windowMs: FIFTEEN_MINUTES,
  max: 20,
  message:
    'Terlalu banyak percobaan login untuk nomor ini. Silakan coba lagi nanti.',
  keyGenerator: loginAccountKey,
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

// Outlet options are used by the report filter and perform a distinct scan;
// keep repeated polling from turning that endpoint into an unbounded read.
const reportOutletsLimiter = createDedicatedLimiter({
  prefix: 'admin-report-outlets',
  windowMs: 60_000,
  max: 30,
  message: 'Terlalu banyak permintaan daftar outlet. Coba lagi sebentar lagi.',
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
  loginAccountKey,
  loginAccountLimiter,
  pruneRateLimitCounters,
  resendActivationTargetLimiter,
  runchiseSyncTargetLimiter,
  reportOutletsLimiter,
  shouldSkipGlobalLimiter,
};
