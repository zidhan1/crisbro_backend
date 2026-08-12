// Probe untuk wibDateBoundary.test.js. BUKAN file test (tidak cocok dengan glob
// `test/*.test.js`), melainkan skrip yang dijalankan ulang di beberapa nilai TZ
// lewat child process.
//
// Mengubah process.env.TZ setelah proses berjalan tidak dijamin memengaruhi
// objek Date yang sudah ada di semua platform, jadi satu-satunya cara jujur
// membuktikan hasilnya tidak bergantung zona runtime adalah menjalankan
// perhitungan yang sama pada proses yang benar-benar start dengan TZ berbeda.
//
// Output: satu baris JSON ke stdout.

const {
  parseDateBoundary,
} = require('../src/controllers/adminLoyalty/adminLoyaltyShared');
const { formatWibDate } = require('../src/lib/wibDate');

const iso = (value) => (value === null ? null : value.toISOString());

process.stdout.write(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    runtimeOffsetMinutes: new Date('2026-08-01T00:00:00Z').getTimezoneOffset(),
    fromDateOnly: iso(parseDateBoundary('2026-08-01', 'from')),
    toDateOnly: iso(parseDateBoundary('2026-08-31', 'to', true)),
    fromNaiveDateTime: iso(parseDateBoundary('2026-08-01T10:00', 'from')),
    toExplicitUtc: iso(parseDateBoundary('2026-08-01T20:00:00Z', 'to', true)),
    yearEnd: iso(parseDateBoundary('2026-12-31', 'to', true)),
    leapDay: iso(parseDateBoundary('2028-02-29', 'from')),
    trendLabel: formatWibDate(new Date('2026-08-11T20:00:00Z')),
  }),
);
