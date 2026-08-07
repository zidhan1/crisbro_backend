// M-12: Menambahkan pengujian integrasi pada proses idempotensi upsert sinkronisasi customer untuk memastikan sinkronisasi berulang dengan data yang sama hanya memperbarui data yang ada tanpa membuat duplikasi.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-node-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { upsertRunchiseCustomersBatch } = require('../src/services/syncService');

const RUNCHISE_CUSTOMER = {
  id: 900123,
  brand_id: 1,
  owner_location_id: 4424,
  owner_location: { name: 'Outlet Test' },
  location_ids: [4424],
  name: 'Idempotency Test Customer',
  phone_number: '81234567890',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  status: 'active',
  balance: 0,
  total_point: 0,
  available_point: 0,
};

// Membangun mock transaksi Prisma untuk mensimulasikan proses create dan update tanpa mengeksekusi operasi database secara langsung.
function makeFakeTx({
  createdUserId = 9001,
  createdCustomerId = 8001,
  phone,
} = {}) {
  let queryRawCallCount = 0;
  return {
    async $queryRaw() {
      queryRawCallCount += 1;
      if (queryRawCallCount === 1) {
        // INSERT INTO "User" (...) RETURNING id, phone_number
        return [{ id: createdUserId, phone_number: phone }];
      }
      // INSERT INTO "Customer" (...) RETURNING id, user_id
      return [{ id: createdCustomerId, user_id: createdUserId }];
    },
    async $executeRaw() {
      return 0;
    },
  };
}

function installCommonMocks(t) {
  const originalExecuteRaw = prisma.$executeRaw;
  const originalTransaction = prisma.$transaction;
  t.after(() => {
    prisma.$executeRaw = originalExecuteRaw;
    prisma.$transaction = originalTransaction;
  });
  // Bulk upsert brand/location di luar transaksi -- tidak relevan untuk tes
  // idempotensi create-vs-update, dibuat no-op.
  prisma.$executeRaw = async () => 0;
}

test('sinkronisasi PERTAMA (customer belum ada): membuat baris baru', async (t) => {
  installCommonMocks(t);

  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  t.after(() => {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  });

  // Belum ada customer lokal yang cocok lewat runchise_id maupun telepon --
  // representasi keadaan database sebelum sinkronisasi pertama.
  prisma.customer.findMany = async () => [];
  prisma.user.findMany = async () => [];
  prisma.$transaction = async (callback) =>
    callback(
      makeFakeTx({
        createdUserId: 9001,
        createdCustomerId: 8001,
        phone: '81234567890',
      }),
    );

  const results = await upsertRunchiseCustomersBatch([RUNCHISE_CUSTOMER], null);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'created');
  assert.equal(results[0].customer_id, 8001);
});

test('sinkronisasi KEDUA dengan data customer yang PERSIS SAMA (idempotensi): tidak membuat duplikat, mengenali sebagai update', async (t) => {
  installCommonMocks(t);

  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  t.after(() => {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  });

  // Sekarang database SUDAH punya baris yang dibuat sinkronisasi pertama --
  // findMany lewat runchise_id menemukannya.
  const existingRow = {
    id: 8001,
    user_id: 9001,
    runchise_id: RUNCHISE_CUSTOMER.id,
    phone_number: '81234567890',
    user: { id: 9001, phone_number: '81234567890', role: 'customer' },
  };
  let transactionCalled = false;
  prisma.customer.findMany = async (args) => {
    if (args.where.runchise_id) return [existingRow];
    return []; // pencarian lewat telepon: tidak relevan di sini
  };
  prisma.user.findMany = async () => [];
  prisma.$transaction = async (callback) => {
    transactionCalled = true;
    return callback(makeFakeTx());
  };

  const results = await upsertRunchiseCustomersBatch([RUNCHISE_CUSTOMER], null);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'updated');
  // customer_id SAMA dengan yang dibuat sinkronisasi pertama -- bukti tidak
  // ada baris duplikat yang dibuat untuk customer Runchise yang sama.
  assert.equal(results[0].customer_id, 8001);
  assert.equal(transactionCalled, true);
});

test('idempotensi dalam SATU halaman: customer yang sama muncul dua kali di respons API tidak menghasilkan dua baris', async (t) => {
  installCommonMocks(t);

  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  t.after(() => {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  });

  prisma.customer.findMany = async () => [];
  prisma.user.findMany = async () => [];
  let createTransactionCount = 0;
  prisma.$transaction = async (callback) => {
    createTransactionCount += 1;
    return callback(
      makeFakeTx({
        createdUserId: 9002,
        createdCustomerId: 8002,
        phone: '81234567890',
      }),
    );
  };

  // Baris identik dikirim dua kali dalam satu halaman -- skenario data
  // duplikat dari API Runchise.
  const results = await upsertRunchiseCustomersBatch(
    [RUNCHISE_CUSTOMER, { ...RUNCHISE_CUSTOMER }],
    null,
  );

  assert.equal(results.length, 2);
  const created = results.filter((r) => r.status === 'created');
  const skipped = results.filter((r) => r.status === 'skipped_conflict');
  assert.equal(created.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'duplicate_phone_in_batch');
  // Hanya SATU transaksi create yang benar-benar dijalankan untuk kedua baris.
  assert.equal(createTransactionCount, 1);
});
