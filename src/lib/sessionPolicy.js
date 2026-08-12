// H-2: Memisahkan sesi menjadi idle TTL yang dapat diperpanjang dan batas absolut JWT yang tidak dapat diperpanjang, dengan staff dibatasi 8 jam idle/24 jam absolut sementara customer tetap 7 hari seperti sebelumnya.

const STAFF_ROLES = new Set(['admin', 'marketing']);

const DEFAULT_STAFF_IDLE_MINUTES = 480; // 8 jam kerja
const DEFAULT_STAFF_ABSOLUTE_HOURS = 24;
const DEFAULT_CUSTOMER_IDLE_DAYS = 7;
const DEFAULT_CUSTOMER_EXPIRES_IN = '7d';
const DEFAULT_RENEW_INTERVAL_MINUTES = 5;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isStaffRole(role) {
  return STAFF_ROLES.has(role);
}

/**
 * Kebijakan masa berlaku sesi untuk sebuah peran.
 *
 * `absoluteExpiresIn` dikembalikan dalam format yang diterima `jsonwebtoken`
 * (mis. '24h'), bukan milidetik, supaya penghitungan batas absolut tetap
 * dilakukan oleh library JWT itu sendiri -- tidak perlu parser durasi sendiri
 * yang bisa meleset dari perilaku `jwt.sign`.
 */
function getSessionPolicy(role) {
  if (isStaffRole(role)) {
    return {
      role: 'staff',
      idleMs:
        positiveNumberEnv(
          'ADMIN_SESSION_IDLE_MINUTES',
          DEFAULT_STAFF_IDLE_MINUTES,
        ) * MINUTE_MS,
      absoluteExpiresIn: `${positiveNumberEnv(
        'ADMIN_SESSION_ABSOLUTE_HOURS',
        DEFAULT_STAFF_ABSOLUTE_HOURS,
      )}h`,
    };
  }

  return {
    role: 'customer',
    idleMs:
      positiveNumberEnv(
        'CUSTOMER_SESSION_IDLE_DAYS',
        DEFAULT_CUSTOMER_IDLE_DAYS,
      ) * DAY_MS,
    absoluteExpiresIn:
      process.env.JWT_EXPIRES_IN || DEFAULT_CUSTOMER_EXPIRES_IN,
  };
}

// Menggeser `expires_at` pada SETIAP request berarti satu UPDATE per request --
// mahal untuk function serverless yang berbagi satu Postgres. Pergeseran karena
// itu hanya ditulis bila selisihnya sudah melewati ambang ini.
function getSessionRenewIntervalMs() {
  return (
    positiveNumberEnv(
      'SESSION_RENEW_INTERVAL_MINUTES',
      DEFAULT_RENEW_INTERVAL_MINUTES,
    ) * MINUTE_MS
  );
}

/**
 * Kedaluwarsa idle untuk sesi yang baru dibuat, tidak pernah melewati batas
 * absolut token.
 */
function computeSessionExpiry({ role, now, tokenExpMs }) {
  const { idleMs } = getSessionPolicy(role);
  return new Date(Math.min(now + idleMs, tokenExpMs));
}

/**
 * Kedaluwarsa idle baru untuk sesi yang sedang dipakai, atau `null` bila belum
 * perlu ditulis ke database.
 *
 * Sengaja simetris: selisih dihitung dengan nilai absolut sehingga sesi lama
 * yang terlanjur dibuat dengan TTL 7 hari ikut DIPERPENDEK ke kebijakan baru
 * pada request pertamanya, bukan hanya sesi hasil login setelah rilis ini.
 * Tanpa itu, semua sesi staff yang sudah aktif akan tetap memegang jendela 7
 * hari sampai kedaluwarsa sendiri.
 */
function computeSlidingSessionExpiry({
  role,
  now,
  tokenExpMs,
  currentExpiresAt,
}) {
  const current =
    currentExpiresAt instanceof Date
      ? currentExpiresAt.getTime()
      : new Date(currentExpiresAt).getTime();

  // Token tanpa klaim `exp` yang sah tidak punya batas absolut yang bisa
  // dipakai sebagai plafon; jangan tulis apa pun daripada menyimpan tanggal
  // Invalid Date ke kolom `expires_at`.
  if (!Number.isFinite(current) || !Number.isFinite(tokenExpMs)) return null;

  const { idleMs } = getSessionPolicy(role);
  const candidate = Math.min(now + idleMs, tokenExpMs);

  if (Math.abs(candidate - current) < getSessionRenewIntervalMs()) return null;

  return new Date(candidate);
}

module.exports = {
  STAFF_ROLES,
  isStaffRole,
  getSessionPolicy,
  getSessionRenewIntervalMs,
  computeSessionExpiry,
  computeSlidingSessionExpiry,
};
