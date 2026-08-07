const test = require('node:test');
const assert = require('node:assert/strict');

// M-3: memverifikasi bahwa route sync manual admin (/admin/sync/*) dan job
// cron per tahap sekarang saling eksklusif lewat advisory lock yang sama
// (RUNCHISE_CRON_LOCK_IDS), bukan lagi dua jalur independen tanpa guard.
//
// withDistributedCronLock aslinya membuka koneksi Postgres sungguhan
// (pg_try_advisory_lock). Di sini kita ganti dengan lock in-memory yang meniru
// semantik "satu lockId hanya bisa dipegang satu pemanggil pada satu waktu",
// lalu ganti fungsi sync asli dengan stub terkendali agar test bisa
// menentukan kapan sebuah "pekerjaan" selesai — tanpa DB/Runchise API
// sungguhan. Modul di-patch SEBELUM index.js/runchiseSyncCron.js pertama kali
// di-require, sehingga destructuring `const { fn } = require(...)` di kedua
// file itu mengikat ke stub, bukan implementasi asli.

const distributedCronLock = require('../src/lib/distributedCronLock');
const syncService = require('../src/services/syncService');

const heldLocks = new Set();
distributedCronLock.withDistributedCronLock = async ({ jobName, lockId, run }) => {
  if (heldLocks.has(lockId)) {
    return { skipped: true, reason: 'distributed_lock_busy', job: jobName };
  }
  heldLocks.add(lockId);
  try {
    return await run();
  } finally {
    heldLocks.delete(lockId);
  }
};

const stubs = {};
for (const name of [
  'syncProducts',
  'syncBrands',
  'syncLocations',
  'syncPromos',
  'syncCustomerPointsFromStaging',
  'syncSalesTransactionReports',
]) {
  syncService[name] = (...args) => stubs[name](...args);
}

const { RUNCHISE_CRON_LOCK_IDS } = distributedCronLock;
const {
  runSyncProductsJob,
  runSyncBrandsJob,
  runSyncLocationsJob,
  runSyncPromosJob,
  runSyncSalesTransactionReportsJob,
  runCustomerPointsSyncJob,
} = require('../src/jobs/runchiseSyncCron');
const app = require('../src/index');
const { handleSyncProducts, handleSyncBrands, handleSyncLocations, handleSyncPromos, handleSyncPoints, handleSyncSalesTransactions } =
  app.__testables;

function createDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const stageCases = [
  {
    label: 'products',
    lockId: RUNCHISE_CRON_LOCK_IDS.products,
    stubName: 'syncProducts',
    runCronJob: runSyncProductsJob,
    callAdminHandler: (res) => handleSyncProducts({ query: {} }, res),
  },
  {
    label: 'brands',
    lockId: RUNCHISE_CRON_LOCK_IDS.brands,
    stubName: 'syncBrands',
    runCronJob: runSyncBrandsJob,
    callAdminHandler: (res) => handleSyncBrands({ query: {} }, res),
  },
  {
    label: 'locations',
    lockId: RUNCHISE_CRON_LOCK_IDS.locations,
    stubName: 'syncLocations',
    runCronJob: runSyncLocationsJob,
    callAdminHandler: (res) => handleSyncLocations({ query: {} }, res),
  },
  {
    label: 'promos',
    lockId: RUNCHISE_CRON_LOCK_IDS.promos,
    stubName: 'syncPromos',
    runCronJob: runSyncPromosJob,
    callAdminHandler: (res) => handleSyncPromos({ query: {} }, res),
  },
  {
    label: 'sales transactions',
    lockId: RUNCHISE_CRON_LOCK_IDS.sales,
    stubName: 'syncSalesTransactionReports',
    runCronJob: runSyncSalesTransactionReportsJob,
    callAdminHandler: (res) => handleSyncSalesTransactions({ query: {} }, res),
  },
  {
    label: 'points',
    lockId: RUNCHISE_CRON_LOCK_IDS.points,
    stubName: 'syncCustomerPointsFromStaging',
    runCronJob: runCustomerPointsSyncJob,
    callAdminHandler: (res) => handleSyncPoints({ query: {} }, res),
  },
];

for (const stage of stageCases) {
  test(`${stage.label}: klik sync manual admin dilewati (409) saat cron sedang berjalan`, async () => {
    const deferred = createDeferred();
    stubs[stage.stubName] = async () => {
      await deferred.promise;
      return { synced: 1 };
    };

    assert.equal(heldLocks.has(stage.lockId), false);

    // Cron "sedang berjalan" — job dipanggil tapi sengaja digantung lewat deferred.
    const cronPromise = stage.runCronJob();
    assert.equal(
      heldLocks.has(stage.lockId),
      true,
      'advisory lock harus sudah dipegang begitu cron mulai jalan',
    );

    // Admin klik sync manual untuk tahap yang sama sementara cron masih berjalan.
    const res = createMockRes();
    await stage.callAdminHandler(res);

    assert.equal(
      res.statusCode,
      409,
      'route manual harus menolak dengan 409, bukan diam-diam tidak melakukan apa pun atau balapan menulis data yang sama',
    );
    assert.equal(res.body.status, 'skipped');
    assert.equal(res.body.reason, 'distributed_lock_busy');

    // Selesaikan cron, pastikan lock dilepas dan hasil aslinya tetap utuh.
    deferred.resolve();
    const cronResult = await cronPromise;
    assert.deepEqual(cronResult, { synced: 1 });
    assert.equal(heldLocks.has(stage.lockId), false);
  });
}

test('arah sebaliknya: cron dilewati saat sync manual admin masih berjalan (products)', async () => {
  const deferred = createDeferred();
  stubs.syncProducts = async () => {
    await deferred.promise;
    return { synced: 7 };
  };

  const res = createMockRes();
  const adminPromise = handleSyncProducts({ query: {} }, res);
  assert.equal(heldLocks.has(RUNCHISE_CRON_LOCK_IDS.products), true);

  const cronResult = await runSyncProductsJob();
  assert.deepEqual(cronResult, {
    skipped: true,
    reason: 'distributed_lock_busy',
    job: 'runchise-sync:products',
  });

  deferred.resolve();
  await adminPromise;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.synced, 7);
  assert.equal(heldLocks.has(RUNCHISE_CRON_LOCK_IDS.products), false);
});

test('setelah lock dilepas, panggilan berikutnya untuk tahap yang sama berjalan normal (tidak stuck)', async () => {
  stubs.syncBrands = async () => ({ synced: 2 });

  const first = createMockRes();
  await handleSyncBrands({ query: {} }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.synced, 2);

  const second = createMockRes();
  await handleSyncBrands({ query: {} }, second);
  assert.equal(
    second.statusCode,
    200,
    'lock tidak boleh tertinggal "held" setelah run sebelumnya selesai',
  );
  assert.equal(second.body.synced, 2);
});
