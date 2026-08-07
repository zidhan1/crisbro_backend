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

function collectSqlValues(value, collected = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSqlValues(item, collected);
  } else if (value && typeof value === 'object' && Array.isArray(value.values)) {
    collectSqlValues(value.values, collected);
  } else {
    collected.push(value);
  }
  return collected;
}

function installCommonMocks(t) {
  const originalExecuteRaw = prisma.$executeRaw;
  const originalTransaction = prisma.$transaction;
  const originalLocationFindMany = prisma.location.findMany;
  t.after(() => {
    prisma.$executeRaw = originalExecuteRaw;
    prisma.$transaction = originalTransaction;
    prisma.location.findMany = originalLocationFindMany;
  });
  // Brand bulk-upsert di luar transaksi tidak relevan untuk tes idempotensi.
  prisma.$executeRaw = async () => 0;
  // Membership Runchise 4424 dipetakan ke primary key lokal yang berbeda.
  // Ini sekaligus menjaga test agar tidak mengasumsikan kedua namespace ID
  // selalu sama.
  prisma.location.findMany = async () => [
    { id: 77, runchise_id: RUNCHISE_CUSTOMER.owner_location_id },
  ];
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

test('customer tanpa nomor telepon tetap diproses dalam bulk transaction', async (t) => {
  installCommonMocks(t);
  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  t.after(() => {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  });

  prisma.customer.findMany = async () => [];
  prisma.user.findMany = async () => [];
  let transactionCalls = 0;
  prisma.$transaction = async (callback) => {
    transactionCalls += 1;
    return callback(
      makeFakeTx({
        createdUserId: 9010,
        createdCustomerId: 8010,
        phone: `__runchise_sync_${RUNCHISE_CUSTOMER.id}`,
      }),
    );
  };

  const [result] = await upsertRunchiseCustomersBatch(
    [{ ...RUNCHISE_CUSTOMER, phone_number: null }],
    null,
  );

  assert.equal(transactionCalls, 1);
  assert.equal(result.status, 'created');
  assert.equal(result.customer_id, 8010);
});

test('membership customer hanya memakai Location master berdasarkan runchise_id', async (t) => {
  const originalExecuteRaw = prisma.$executeRaw;
  const originalTransaction = prisma.$transaction;
  const originalLocationFindMany = prisma.location.findMany;
  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  const outerStatements = [];
  const transactionStatements = [];
  let locationLookup;

  t.after(() => {
    prisma.$executeRaw = originalExecuteRaw;
    prisma.$transaction = originalTransaction;
    prisma.location.findMany = originalLocationFindMany;
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  });

  prisma.location.findMany = async (args) => {
    locationLookup = args;
    return [{ id: 77, runchise_id: 4424 }];
  };
  prisma.customer.findMany = async () => [];
  prisma.user.findMany = async () => [];
  prisma.$executeRaw = async (strings) => {
    outerStatements.push(strings.join(''));
    return 0;
  };
  prisma.$transaction = async (callback) =>
    callback({
      async $queryRaw(strings) {
        const sql = strings.join('');
        return sql.includes('INSERT INTO "User"')
          ? [{ id: 9001, phone_number: '81234567890' }]
          : [{ id: 8001, user_id: 9001 }];
      },
      async $executeRaw(strings, ...values) {
        transactionStatements.push({ sql: strings.join(''), values });
        return 0;
      },
    });

  const [result] = await upsertRunchiseCustomersBatch(
    [RUNCHISE_CUSTOMER],
    null,
  );

  assert.deepEqual(locationLookup.where, {
    runchise_id: { in: [4424] },
  });
  assert.equal(
    outerStatements.some((sql) => sql.includes('INSERT INTO "Location"')),
    false,
  );
  const membershipInsert = transactionStatements.find((statement) =>
    statement.sql.includes('INSERT INTO "CustomerLocation"'),
  );
  assert.ok(membershipInsert);
  const membershipValues = collectSqlValues(membershipInsert.values);
  assert.ok(membershipValues.includes(77));
  assert.equal(membershipValues.includes(4424), false);
  assert.deepEqual(result.unresolved_location_ids, []);
});

test('membership tanpa Location master diabaikan tanpa membuat outlet hantu', async (t) => {
  installCommonMocks(t);

  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  const originalConsoleWarn = console.warn;
  const statements = [];
  t.after(() => {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
    console.warn = originalConsoleWarn;
  });

  prisma.location.findMany = async () => [];
  prisma.customer.findMany = async () => [];
  prisma.user.findMany = async () => [];
  prisma.$executeRaw = async (strings) => {
    statements.push(strings.join(''));
    return 0;
  };
  console.warn = () => {};
  let membershipWritten = false;
  prisma.$transaction = async (callback) =>
    callback({
      async $queryRaw(strings) {
        return strings.join('').includes('INSERT INTO "User"')
          ? [{ id: 9001, phone_number: '81234567890' }]
          : [{ id: 8001, user_id: 9001 }];
      },
      async $executeRaw(strings) {
        if (strings.join('').includes('INSERT INTO "CustomerLocation"')) {
          membershipWritten = true;
        }
        return 0;
      },
    });

  const [result] = await upsertRunchiseCustomersBatch(
    [RUNCHISE_CUSTOMER],
    null,
  );

  assert.equal(
    statements.some((sql) => sql.includes('INSERT INTO "Location"')),
    false,
  );
  assert.equal(membershipWritten, false);
  assert.deepEqual(result.unresolved_location_ids, [4424]);
});
