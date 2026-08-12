const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// M-4 (lanjutan): batas rentang tanggal dashboard dulu dihitung dengan
// `date.setHours(...)` yang mengikuti zona proses. Vercel menjalankan function
// dalam UTC, sehingga filter "1-31 Agustus" sebenarnya mengambil
// 1 Agu 07:00 WIB s/d 1 Sep 06:59 WIB -- transaksi dini hari 1 Agustus hilang
// dari laporan dan transaksi dini hari 1 September ikut terhitung.
//
// Test ini mengunci dua hal:
// 1. Batasnya sekarang tepat pada tengah malam / akhir hari WIB.
// 2. Hasilnya identik di zona runtime mana pun (UTC production, UTC+7 laptop
//    developer, dan satu zona negatif sebagai kontrol).

const {
  parseDateBoundary,
  parseOptionalDate,
} = require('../src/controllers/adminLoyalty/adminLoyaltyShared');
const { ValidationError } = require('../src/lib/validationError');
const {
  formatWibDate,
  parseWibInstant,
  startOfWibDay,
  endOfWibDay,
} = require('../src/lib/wibDate');
const { toRedemptionTrend } = require('../src/lib/loyaltySummaryProjection');

// 1 Agustus 2026 00:00:00.000 WIB == 31 Juli 2026 17:00:00.000Z
const AUG_1_START_WIB = '2026-07-31T17:00:00.000Z';
// 31 Agustus 2026 23:59:59.999 WIB == 31 Agustus 2026 16:59:59.999Z
const AUG_31_END_WIB = '2026-08-31T16:59:59.999Z';

test('batas awal rentang jatuh tepat tengah malam WIB, bukan tengah malam UTC', () => {
  assert.equal(
    parseDateBoundary('2026-08-01', 'from').toISOString(),
    AUG_1_START_WIB,
  );
});

test('batas akhir rentang jatuh tepat akhir hari WIB, bukan akhir hari UTC', () => {
  assert.equal(
    parseDateBoundary('2026-08-31', 'to', true).toISOString(),
    AUG_31_END_WIB,
  );
});

test('regresi: transaksi dini hari di tanggal awal rentang tidak lagi hilang', () => {
  const from = parseDateBoundary('2026-08-01', 'from');
  // 1 Agustus 2026 02:00 WIB -- sebelumnya jatuh di luar batas UTC dan hilang
  // dari laporan meskipun pengguna memfilter mulai 1 Agustus.
  const dinihariSatuAgustusWib = new Date('2026-07-31T19:00:00.000Z');

  assert.ok(dinihariSatuAgustusWib >= from);
  // Bukti bahwa perilaku LAMA memang menyingkirkannya.
  assert.ok(dinihariSatuAgustusWib < new Date('2026-08-01T00:00:00.000Z'));
});

test('regresi: transaksi dini hari di hari SETELAH rentang tidak lagi ikut terhitung', () => {
  const to = parseDateBoundary('2026-08-31', 'to', true);
  // 1 September 2026 03:00 WIB -- sebelumnya masih masuk karena batas UTC.
  const dinihariSatuSeptemberWib = new Date('2026-08-31T20:00:00.000Z');

  assert.ok(dinihariSatuSeptemberWib > to);
  // Bukti bahwa perilaku LAMA memang ikut menghitungnya.
  assert.ok(dinihariSatuSeptemberWib <= new Date('2026-08-31T23:59:59.999Z'));
});

test('rentang satu hari mencakup tepat 24 jam WIB tanpa celah maupun tumpang tindih', () => {
  const from = parseDateBoundary('2026-08-01', 'from');
  const to = parseDateBoundary('2026-08-01', 'to', true);
  const berikutnya = parseDateBoundary('2026-08-02', 'from');

  assert.equal(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000 - 1);
  // Akhir hari dan awal hari berikutnya bersambung persis 1 ms.
  assert.equal(berikutnya.getTime() - to.getTime(), 1);
});

test('nilai kosong tetap berarti "tanpa filter", bukan error', () => {
  for (const kosong of [undefined, null, '']) {
    assert.equal(parseDateBoundary(kosong, 'from'), null);
    assert.equal(parseDateBoundary(kosong, 'to', true), null);
  }
});

test('nilai tidak valid ditolak sebagai ValidationError (400), bukan 500', () => {
  assert.throws(
    () => parseDateBoundary('bukan-tanggal', 'from'),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.message, 'from harus berupa tanggal valid');
      return true;
    },
  );
});

test('ISO tanpa offset dibaca sebagai jam WIB, bukan jam lokal runtime', () => {
  // 1 Agustus 10:00 WIB masih hari yang sama -> dijepit ke awal hari WIB.
  assert.equal(
    parseDateBoundary('2026-08-01T10:00', 'from').toISOString(),
    AUG_1_START_WIB,
  );
});

test('instant dengan offset eksplisit dipetakan ke hari kalender WIB yang memuatnya', () => {
  // 2026-08-01T20:00Z == 2 Agustus 03:00 WIB -> hari kalender WIB-nya 2 Agustus.
  assert.equal(
    parseDateBoundary('2026-08-01T20:00:00Z', 'from').toISOString(),
    '2026-08-01T17:00:00.000Z',
  );
});

test('pergantian bulan, tahun, dan tahun kabisat tetap tepat di WIB', () => {
  assert.equal(
    parseDateBoundary('2026-12-31', 'to', true).toISOString(),
    '2026-12-31T16:59:59.999Z',
  );
  assert.equal(
    parseDateBoundary('2027-01-01', 'from').toISOString(),
    '2026-12-31T17:00:00.000Z',
  );
  assert.equal(
    parseDateBoundary('2028-02-29', 'from').toISOString(),
    '2028-02-28T17:00:00.000Z',
  );
});

test('parseOptionalDate TIDAK ikut bergeser ke WIB (dob kolom @db.Date)', () => {
  // Menggeser dob ke WIB akan memundurkan tanggal lahir satu hari saat disimpan
  // ke kolom bertipe date, jadi jalur ini sengaja tetap ditambatkan ke UTC.
  assert.equal(
    parseOptionalDate('1990-05-12', 'dob').toISOString(),
    '1990-05-12T00:00:00.000Z',
  );
});

// ===================== BUCKET TREN GRAFIK =====================

test('label hari tren memakai kalender WIB', () => {
  // 11 Agustus 20:00Z == 12 Agustus 03:00 WIB -> harus masuk bucket 12 Agustus.
  assert.equal(formatWibDate(new Date('2026-08-11T20:00:00.000Z')), '2026-08-12');
  // Kontrol: kalender UTC akan menaruhnya di 11 Agustus.
  assert.equal(
    new Date('2026-08-11T20:00:00.000Z').toISOString().slice(0, 10),
    '2026-08-11',
  );
});

test('toRedemptionTrend menerima label TEXT hasil TO_CHAR dari SQL', () => {
  assert.deepEqual(
    toRedemptionTrend([
      { date: '2026-08-12', redemption_count: '4.5', points_spent: '900' },
    ]),
    [{ date: '2026-08-12', redemption_count: 4.5, points_spent: 900 }],
  );
});

// ===================== INDEPENDENSI ZONA RUNTIME =====================

test('hasil identik di UTC (production), UTC+7 (laptop dev), dan zona negatif', () => {
  const probe = path.join(__dirname, 'wibDateBoundaryProbe.js');
  const zones = ['UTC', 'Asia/Jakarta', 'America/New_York'];

  const hasil = zones.map((tz) =>
    JSON.parse(
      execFileSync(process.execPath, [probe], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }),
    ),
  );

  // Prasyarat: ketiga proses memang benar-benar start di zona berbeda.
  const offsets = hasil.map((row) => row.runtimeOffsetMinutes);
  assert.equal(new Set(offsets).size, 3, `offset runtime tidak berbeda: ${offsets}`);

  const nilaiTanggal = ({ tz, runtimeOffsetMinutes, ...rest }) => rest;
  const acuan = nilaiTanggal(hasil[0]);

  for (const row of hasil.slice(1)) {
    assert.deepEqual(
      nilaiTanggal(row),
      acuan,
      `hasil berbeda pada TZ=${row.tz}`,
    );
  }

  // Sekaligus kunci nilainya, bukan sekadar "sama-sama konsisten".
  assert.equal(acuan.fromDateOnly, AUG_1_START_WIB);
  assert.equal(acuan.toDateOnly, AUG_31_END_WIB);
  assert.equal(acuan.trendLabel, '2026-08-12');
});
