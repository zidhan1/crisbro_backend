// M-4 (lanjutan): satu-satunya tempat zona waktu bisnis didefinisikan.
//
// Seluruh data Runchise (tanggal transaksi, promo, redemption) memakai kalender
// WIB/Asia_Jakarta (UTC+7 tetap, tanpa DST). Runtime aplikasi TIDAK memakai zona
// itu: Vercel menjalankan function dalam UTC dan tidak ada `TZ` yang diset di
// vercel.json maupun env, sementara mesin developer di Indonesia berjalan di
// UTC+7. Setiap helper tanggal yang memakai API waktu lokal (`setHours`,
// `getFullYear`, `new Date('YYYY-MM-DDTHH:mm')`) karena itu memberi hasil yang
// BERBEDA antara laptop developer dan production -- kelas bug yang sama dengan
// M-4 pada parsing tanggal promo.
//
// Semua fungsi di modul ini hanya memakai API UTC (`Date.UTC`, `getUTC*`) plus
// offset eksplisit, sehingga hasilnya identik di zona runtime mana pun.

const WIB_OFFSET_MINUTES = 7 * 60;
const WIB_OFFSET_MS = WIB_OFFSET_MINUTES * 60 * 1000;
const WIB_OFFSET_SUFFIX = '+07:00';

// 'YYYY-MM-DD' — bentuk yang dikirim <input type="date">.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 'YYYY-MM-DDTHH:mm[:ss[.sss]]' TANPA offset. ECMAScript menafsirkan bentuk ini
// sebagai waktu LOKAL runtime (berbeda dari bentuk date-only yang ditafsirkan
// sebagai UTC), jadi bentuk inilah yang paling berbahaya bila dibiarkan.
const NAIVE_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * Mengubah nilai apa pun menjadi satu instant (Date) tanpa bergantung pada zona
 * runtime.
 *
 * Aturan penafsiran:
 * - `Date`/epoch number  -> dipakai apa adanya (sudah berupa instant absolut).
 * - 'YYYY-MM-DD'         -> tengah malam WIB pada tanggal tersebut.
 * - ISO tanpa offset     -> jam dindingnya dibaca sebagai jam WIB.
 * - ISO dengan offset/Z  -> instant absolut, dihormati apa adanya.
 *
 * Mengembalikan `null` bila nilai tidak dapat diurai.
 */
function parseWibInstant(value) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let normalized = raw;
  if (DATE_ONLY_PATTERN.test(raw)) {
    normalized = `${raw}T00:00:00.000${WIB_OFFSET_SUFFIX}`;
  } else if (NAIVE_DATE_TIME_PATTERN.test(raw)) {
    normalized = `${raw.replace(' ', 'T')}${WIB_OFFSET_SUFFIX}`;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Komponen kalender WIB dari sebuah instant. Digeser dulu lalu dibaca dengan
// getUTC* supaya zona runtime tidak pernah ikut menentukan hasilnya.
function getWibDateParts(date) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function wibWallClockToInstant(year, month, day, hour, minute, second, ms) {
  // Date.UTC memperlakukan tahun 0-99 sebagai 19xx; tahun kita selalu 4 digit
  // hasil parsing ISO, tapi setUTCFullYear dipakai agar tetap benar bila suatu
  // saat ada tanggal historis.
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, ms);
  return new Date(wallClock.getTime() - WIB_OFFSET_MS);
}

/** Instant saat hari kalender WIB yang memuat `date` dimulai (00:00:00.000 WIB). */
function startOfWibDay(date) {
  const { year, month, day } = getWibDateParts(date);
  return wibWallClockToInstant(year, month, day, 0, 0, 0, 0);
}

/** Instant terakhir yang masih termasuk hari kalender WIB tersebut (23:59:59.999 WIB). */
function endOfWibDay(date) {
  const { year, month, day } = getWibDateParts(date);
  return wibWallClockToInstant(year, month, day, 23, 59, 59, 999);
}

/** Label tanggal kalender WIB ('YYYY-MM-DD') dari sebuah instant. */
function formatWibDate(date) {
  const { year, month, day } = getWibDateParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

module.exports = {
  WIB_OFFSET_MINUTES,
  WIB_OFFSET_MS,
  WIB_OFFSET_SUFFIX,
  parseWibInstant,
  getWibDateParts,
  startOfWibDay,
  endOfWibDay,
  formatWibDate,
};
