const test = require('node:test');
const assert = require('node:assert/strict');

// L-3: kegagalan validasi harus dikenali dari TIPE error, bukan dari isi
// pesannya, dan harus terpetakan ke 400 -- bukan 500.
//
// Dua sisa temuan itu ditutup di sini:
// 1. summaryController melempar `Error` biasa untuk `outlet_id` yang tidak
//    dikenal. `handleError` hanya mengenali ValidationError dan kode Prisma,
//    jadi kesalahan input pengguna terkirim sebagai 500 "kesalahan server"
//    beserta error_id, sekaligus mengotori log error dengan noise.
// 2. rewardsCatalogController mengklasifikasi error lewat
//    `error.message?.includes('harus')`. Pencocokan string itu salah di DUA
//    arah: error internal yang kebetulan memuat kata "harus" ikut terkirim
//    sebagai 400 beserta pesan aslinya (membocorkan detail internal yang justru
//    disembunyikan respondWithServerError), sedangkan pesan validasi tanpa kata
//    itu dilaporkan sebagai 500.

const { createGetSummary } = require('../src/controllers/adminLoyalty/summaryController');
const {
  handleError,
  parsePositiveInt,
  parseDateBoundary,
} = require('../src/controllers/adminLoyalty/adminLoyaltyShared');
const { ValidationError } = require('../src/lib/validationError');
const { GENERIC_MESSAGE } = require('../src/lib/serverError');
const prisma = require('../src/lib/prisma');

function createResponseSpy() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      if (this.statusCode === null) this.statusCode = 200;
      return this;
    },
  };
}

// ===================== getSummary: outlet_id =====================

function buildGetSummary(findUnique) {
  return createGetSummary({
    prisma: { location: { findUnique } },
    Prisma: {},
    parsePositiveInt,
    parseDateBoundary,
    toRedemptionTrend: () => [],
    toPublicRedemptionHistory: () => [],
    handleError,
    ValidationError,
  });
}

test('outlet_id yang tidak ada dibalas 400 dengan pesan yang bisa ditindaklanjuti', async () => {
  const getSummary = buildGetSummary(async () => null);
  const res = createResponseSpy();

  await getSummary({ query: { outlet_id: '999' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(
    res.body.message,
    'outlet_id tidak ditemukan atau bukan outlet Runchise',
  );
  // Bukan balasan 500: tidak boleh ada error_id maupun pesan generik.
  assert.equal('error_id' in res.body, false);
  assert.notEqual(res.body.message, GENERIC_MESSAGE);
});

test('outlet yang ada tapi bukan outlet Runchise juga dibalas 400', async () => {
  const getSummary = buildGetSummary(async () => ({ runchise_id: null }));
  const res = createResponseSpy();

  await getSummary({ query: { outlet_id: '7' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /bukan outlet Runchise/);
});

test('outlet_id bukan angka positif tetap 400 (validasi parser)', async () => {
  const getSummary = buildGetSummary(async () => {
    throw new Error('findUnique seharusnya tidak dipanggil');
  });
  const res = createResponseSpy();

  await getSummary({ query: { outlet_id: '-3' } }, res);

  assert.equal(res.statusCode, 400);
});

test('kegagalan tak terduga TETAP 500 dan pesannya tidak bocor', async () => {
  // Penjaga regresi: perbaikan ini tidak boleh membuat semua error jadi 400.
  const getSummary = buildGetSummary(async () => {
    throw new Error('relation "Location" does not exist');
  });
  const res = createResponseSpy();

  await getSummary({ query: { outlet_id: '7' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, GENERIC_MESSAGE);
  assert.ok(res.body.error_id);
  assert.equal(res.body.message.includes('Location'), false);
});

// ===================== rewardsCatalogController =====================

const originalRewardsCatalog = { ...prisma.rewardsCatalog };

test.after(() => {
  Object.assign(prisma.rewardsCatalog, originalRewardsCatalog);
});

const rewardsCatalogController = require('../src/controllers/rewardsCatalogController');

test('parameter query tidak valid dibalas 400 oleh katalog reward', async () => {
  prisma.rewardsCatalog.findMany = async () => {
    throw new Error('findMany seharusnya tidak dipanggil');
  };
  const res = createResponseSpy();

  await rewardsCatalogController.getAll({ query: { brand_id: 'abc' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'brand_id harus berupa integer positif');
});

test('is_active non-boolean dibalas 400, bukan 500', async () => {
  prisma.rewardsCatalog.findMany = async () => [];
  const res = createResponseSpy();

  await rewardsCatalogController.getAll({ query: { is_active: 'mungkin' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'is_active harus berupa boolean');
});

test('error internal yang memuat kata "harus" TIDAK lagi disalahartikan sebagai 400', async () => {
  // Inti bug substring: pesan internal seperti ini dulu terkirim apa adanya ke
  // client dengan status 400, membocorkan struktur database.
  prisma.rewardsCatalog.findMany = async () => {
    throw new Error(
      'Kolom "points_required" harus bertipe integer pada relasi RewardsCatalog',
    );
  };
  const res = createResponseSpy();

  await rewardsCatalogController.getAll({ query: {} }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, GENERIC_MESSAGE);
  assert.ok(res.body.error_id);
  assert.equal(res.body.message.includes('points_required'), false);
  assert.equal(res.body.message.includes('RewardsCatalog'), false);
});

test('klasifikasi validasi tidak bergantung pada kata tertentu dalam pesan', async () => {
  // Sisi sebaliknya: ValidationError tanpa kata "harus" tetap 400.
  prisma.rewardsCatalog.findMany = async () => {
    throw new ValidationError('brand_id wajib diisi');
  };
  const res = createResponseSpy();

  await rewardsCatalogController.getAll({ query: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'brand_id wajib diisi');
});

test('error Prisma P2003 pada create tetap dipetakan ke 400 brand_id tidak valid', async () => {
  // Penjaga regresi: cabang penanganan kode Prisma tidak ikut berubah.
  prisma.rewardsCatalog.create = async () => {
    throw Object.assign(new Error('FK gagal'), { code: 'P2003' });
  };
  const res = createResponseSpy();

  await rewardsCatalogController.create(
    { body: { brand_id: 1, name: 'Kopi', points_required: 100 } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'brand_id tidak valid');
});
