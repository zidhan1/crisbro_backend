const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient, Prisma } = require('@prisma/client');
const { Client } = require('pg');

function disposableUrl() {
  const value = process.env.LOAD_TEST_DATABASE_URL;
  if (!value) throw new Error('LOAD_TEST_DATABASE_URL wajib diisi');
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('Integration test PostgreSQL hanya boleh memakai host loopback');
  }
  if (!/(load|test)/i.test(database)) {
    throw new Error('Nama database integration test wajib memuat load atau test');
  }
  return value;
}

const connectionString = disposableUrl();
process.env.DATABASE_URL = connectionString;
process.env.DIRECT_URL = connectionString;
process.env.JWT_SECRET ||= 'postgres-integration-test-secret';

const prisma = new PrismaClient({ datasourceUrl: connectionString });
const { createRedeemAdminControllers } = require('../src/controllers/adminLoyalty/redeemAdminController');
const { deleteAdminCustomer } = require('../src/controllers/adminLoyaltyController');
const {
  bulkWriteSalesTransactionReports,
  syncSalesTransactionReportsPage,
  bulkUpsertCustomerPoints,
} = require('../src/services/syncService');
const {
  SALES_SYNC_WORKER_LOCK_ID,
  processSalesPage,
} = require('../src/services/salesTransactionSyncService');
const {
  createCatalogSyncJob,
  processCatalogSyncJobs,
} = require('../src/services/catalogSyncJobService');
const { loginAccountKey } = require('../src/lib/rateLimit');

let sequence = 0;
const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

function parsePositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} invalid`);
  return parsed;
}

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const { updateRedemptionStatus } = createRedeemAdminControllers({
  prisma,
  Prisma,
  parsePositiveInt,
  parseRequiredString: (value) => String(value),
  badRequest: (res, message) => res.status(400).json({ message }),
  handleError: (res, error) => res.status(error.code === 'P2025' ? 404 : 500).json({ message: error.message }),
  recordAdminActivity: async () => {},
  getDefaultRewardThreshold: () => 2000,
  EXCLUDED_CRISBAR_CATEGORY_NAMES: [],
  getRedeemCatalogConfig: () => ({}),
  normalizeReportName: (value) => value,
  parseOptionalString: (value) => value,
  parseBoolean: Boolean,
  parseNonNegativeInt: Number,
  parseOptionalDate: (value) => value,
  buildRedeemItemOrderBy: () => [],
  addRedeemPriceBreakdown: (value) => value,
  getDefaultRedeemCategoryId: async () => 1,
  REDEEM_ITEM_SELECT: {},
  REDEEM_ITEM_AUDIT_INCLUDE: {},
});

async function baseCustomer() {
  const marker = unique('pg-int');
  const brand = await prisma.brand.create({ data: { name: marker } });
  const user = await prisma.user.create({
    data: { email: `${marker}@example.test`, password_hash: 'not-used', role: 'customer' },
  });
  const customer = await prisma.customer.create({
    data: { user_id: user.id, brand_id: brand.id, name: marker },
  });
  return { marker, brand, user, customer };
}

test('database menganonimkan seluruh snapshot PII sebelum customer dihapus', async () => {
  const base = await baseCustomer();
  const runchiseCustomerId = 800000000 + sequence;
  await prisma.customer.update({
    where: { id: base.customer.id },
    data: { runchise_id: runchiseCustomerId },
  });
  const report = await prisma.customerSalesTransactionReport.create({
    data: {
      source_location_id: 880001,
      runchise_sales_transaction_id: 880000000 + sequence,
      runchise_customer_id: runchiseCustomerId,
      customer_id: base.customer.id,
      nama_pelanggan: 'PII harus dihapus',
      no_telepon: '081234567890',
      raw: { customer_phone: '081234567890' },
    },
  });
  const redemption = await prisma.runchisePosRewardRedemption.create({
    data: {
      sale_transaction_id: 890000000 + sequence,
      sale_detail_transaction_id: 1,
      runchise_product_id: 1,
      runchise_customer_id: runchiseCustomerId,
      customer_id: base.customer.id,
      customer_name: 'PII harus dihapus',
      customer_phone_number: '081234567890',
      product_name: 'Integration reward',
      location_id: 880001,
      redeemed_at: new Date(),
      quantity: 1,
      point_per_item: 100,
      points_spent: 100,
      selling_price: 0,
      raw: { customer_phone: '081234567890' },
    },
  });

  // Sengaja delete langsung di database, melewati deleteAdminCustomer, untuk
  // membuktikan kebijakan retensi tetap ditegakkan oleh trigger.
  await prisma.customer.delete({ where: { id: base.customer.id } });

  const [retainedReport, retainedRedemption] = await Promise.all([
    prisma.customerSalesTransactionReport.findUnique({ where: { id: report.id } }),
    prisma.runchisePosRewardRedemption.findUnique({ where: { id: redemption.id } }),
  ]);
  assert.equal(retainedReport.customer_id, null);
  assert.equal(retainedReport.nama_pelanggan, null);
  assert.equal(retainedReport.no_telepon, null);
  assert.equal(retainedReport.raw, null);
  assert.equal(retainedRedemption.customer_id, null);
  assert.equal(retainedRedemption.customer_name, null);
  assert.equal(retainedRedemption.customer_phone_number, null);
  assert.equal(retainedRedemption.raw, null);
});

async function redemptionFixture({ available = 500, points = 150, status = 'pending' } = {}) {
  const base = await baseCustomer();
  await prisma.customerPoint.create({
    data: { customer_id: base.customer.id, total_point: available, available_point: available },
  });
  const reward = await prisma.rewardsCatalog.create({
    data: { brand_id: base.brand.id, name: `${base.marker}-reward`, points_required: points },
  });
  const redemption = await prisma.rewardRedemption.create({
    data: {
      customer_id: base.customer.id,
      reward_id: reward.id,
      points_spent: points,
      status,
      redemption_code: unique('code'),
      redeemed_at: status === 'claimed' ? new Date() : null,
    },
  });
  return { ...base, reward, redemption };
}

function redemptionRequest(id, status) {
  return {
    params: { id: String(id) },
    body: { status },
    user: { id: 1, role: 'admin' },
    get: () => null,
    ip: '127.0.0.1',
  };
}

function sale(locationId, id, earnedPoint = 10) {
  return {
    id,
    customer_id: null,
    location_id: locationId,
    location_name: `Outlet ${locationId}`,
    customer_name: 'Integration Fixture',
    sales_time: '2026-08-11T12:00:00+07:00',
    status: 'completed',
    net_sales_after_tax: 50000,
    metadata: { earned_point: earnedPoint, redeemed_point: 0, available_point: 100 },
    payments: [],
    sale_detail_transactions: [],
  };
}

test.after(async () => prisma.$disconnect());

test('debit dan refund poin benar-benar atomik di PostgreSQL', async () => {
  const fixture = await redemptionFixture({ available: 500, points: 150 });
  const claim = responseMock();
  await updateRedemptionStatus(redemptionRequest(fixture.redemption.id, 'claimed'), claim);
  assert.equal(claim.statusCode, 200);
  assert.equal((await prisma.customerPoint.findUnique({ where: { customer_id: fixture.customer.id } })).available_point, 350);

  const refund = responseMock();
  await updateRedemptionStatus(redemptionRequest(fixture.redemption.id, 'expired'), refund);
  assert.equal(refund.statusCode, 200);
  const [point, histories] = await Promise.all([
    prisma.customerPoint.findUnique({ where: { customer_id: fixture.customer.id } }),
    prisma.pointHistory.findMany({ where: { reward_redemption_id: fixture.redemption.id }, orderBy: { id: 'asc' } }),
  ]);
  assert.equal(point.available_point, 500);
  assert.deepEqual(histories.map((row) => row.points_change), [-150, 150]);
  assert.deepEqual(histories.map((row) => row.type), ['redeem', 'redeem_refund']);
});

test('dua request claim bersamaan hanya mendebit satu kali', async () => {
  const fixture = await redemptionFixture({ available: 500, points: 150 });
  const responses = [responseMock(), responseMock()];
  await Promise.all(
    responses.map((res) => updateRedemptionStatus(redemptionRequest(fixture.redemption.id, 'claimed'), res)),
  );
  assert.deepEqual(responses.map((res) => res.statusCode).sort(), [200, 400]);
  const [point, historyCount] = await Promise.all([
    prisma.customerPoint.findUnique({ where: { customer_id: fixture.customer.id } }),
    prisma.pointHistory.count({ where: { reward_redemption_id: fixture.redemption.id, type: 'redeem' } }),
  ]);
  assert.equal(point.available_point, 350);
  assert.equal(historyCount, 1);
});

test('M-6: sync nyata menunggu row lock dan mempertahankan debit redemption', async () => {
  const fixture = await baseCustomer();
  await prisma.customerPoint.create({
    data: {
      customer_id: fixture.customer.id,
      total_point: 500,
      available_point: 500,
      runchise_total_point: 500,
      runchise_available_point: 500,
    },
  });

  let locked;
  const lockedPromise = new Promise((resolve) => { locked = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const debit = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CustomerPoint" WHERE customer_id = ${fixture.customer.id} FOR UPDATE`;
    await tx.customerPoint.update({
      where: { customer_id: fixture.customer.id },
      data: { available_point: { decrement: 150 } },
    });
    locked();
    await releasePromise;
  });

  await lockedPromise;
  let syncFinished = false;
  const sync = bulkUpsertCustomerPoints([{
    customerId: fixture.customer.id,
    totalPoint: 525,
    availablePoint: 525,
  }]).then((value) => { syncFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(syncFinished, false, 'sync harus menunggu mutasi lokal yang memegang row lock');
  release();
  await Promise.all([debit, sync]);

  const point = await prisma.customerPoint.findUnique({
    where: { customer_id: fixture.customer.id },
  });
  assert.equal(point.total_point, 525);
  assert.equal(point.available_point, 375);
  assert.equal(point.runchise_available_point, 525);
});

test('M-6: constraint database menolak seluruh bentuk saldo CustomerPoint invalid', async () => {
  const fixture = await baseCustomer();
  const invalidRows = [
    { total: -1, available: 0 },
    { total: 10, available: -1 },
    { total: 10, available: 11 },
  ];
  for (const row of invalidRows) {
    await assert.rejects(
      prisma.customerPoint.create({
        data: {
          customer_id: fixture.customer.id,
          total_point: row.total,
          available_point: row.available,
        },
      }),
    );
  }
});

test('M-6: snapshot invalid ditolak tanpa mengubah saldo efektif atau baseline', async () => {
  const fixture = await baseCustomer();
  await prisma.customerPoint.create({
    data: {
      customer_id: fixture.customer.id,
      total_point: 500,
      available_point: 350,
      runchise_total_point: 500,
      runchise_available_point: 500,
    },
  });
  const written = await bulkUpsertCustomerPoints([{
    customerId: fixture.customer.id,
    totalPoint: 100,
    availablePoint: 200,
  }]);
  assert.equal(written, 0);
  const point = await prisma.customerPoint.findUnique({
    where: { customer_id: fixture.customer.id },
  });
  assert.deepEqual(
    [point.total_point, point.available_point, point.runchise_total_point, point.runchise_available_point],
    [500, 350, 500, 500],
  );
});

test('advisory lock saling mengecualikan antar-koneksi PostgreSQL', async () => {
  const first = new Client({ connectionString });
  const second = new Client({ connectionString });
  await Promise.all([first.connect(), second.connect()]);
  try {
    assert.equal((await first.query('SELECT pg_try_advisory_lock($1) acquired', [SALES_SYNC_WORKER_LOCK_ID])).rows[0].acquired, true);
    assert.equal((await second.query('SELECT pg_try_advisory_lock($1) acquired', [SALES_SYNC_WORKER_LOCK_ID])).rows[0].acquired, false);
    await first.query('SELECT pg_advisory_unlock($1)', [SALES_SYNC_WORKER_LOCK_ID]);
    assert.equal((await second.query('SELECT pg_try_advisory_lock($1) acquired', [SALES_SYNC_WORKER_LOCK_ID])).rows[0].acquired, true);
  } finally {
    await Promise.allSettled([
      first.query('SELECT pg_advisory_unlock($1)', [SALES_SYNC_WORKER_LOCK_ID]),
      second.query('SELECT pg_advisory_unlock($1)', [SALES_SYNC_WORKER_LOCK_ID]),
    ]);
    await Promise.allSettled([first.end(), second.end()]);
  }
});

test('C-1: catalog worker menyimpan cursor lalu melanjutkan halaman berikutnya di invocation baru', async () => {
  const creation = await createCatalogSyncJob('brands', { source: 'integration-test' });
  assert.equal(creation.created, true);
  const fetched = [];
  const dependencies = {
    fetchSubBrandsPage: async (page, options) => {
      fetched.push(page);
      assert.deepEqual(options, { retries: 0 });
      return {
        sub_brands: [{ id: page, brand: { id: 750, name: 'Crisbar' }, product_categories: [] }],
        paging: { next_page: page === 1 ? 2 : null, total_item: 2 },
      };
    },
    syncBrands: async (rows) => ({ synced: rows.length }),
  };
  const first = await processCatalogSyncJobs({ kind: 'brands', maxPages: 1 }, dependencies);
  assert.equal(first.status, 'running');
  assert.equal(first.job.current_page, 2);
  assert.equal(first.job.pages_processed, 1);

  const second = await processCatalogSyncJobs({ kind: 'brands', maxPages: 1 }, dependencies);
  assert.equal(second.status, 'completed');
  assert.equal(second.job.pages_processed, 2);
  assert.equal(second.job.processed, 2);
  assert.deepEqual(fetched, [1, 2]);
});

test('C-1: unique partial index mencegah dua job aktif untuk stage sama', async () => {
  const first = await createCatalogSyncJob('locations', { source: 'integration-test' });
  const second = await createCatalogSyncJob('locations', { source: 'integration-test' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
});

test('C-1: halaman gagal tidak memajukan cursor dan berhenti setelah tiga kegagalan beruntun', async () => {
  const creation = await createCatalogSyncJob('promos', { source: 'integration-test' });
  const dependencies = {
    fetchPromosPage: async () => { throw new Error('synthetic upstream failure'); },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(
      processCatalogSyncJobs({ kind: 'promos', maxPages: 1 }, dependencies),
      /synthetic upstream failure/,
    );
    const [row] = await prisma.$queryRaw`
      SELECT * FROM "CatalogSyncJob" WHERE id = ${creation.job.id}
    `;
    assert.equal(row.current_page, 1);
    assert.equal(row.pages_processed, 0);
    assert.equal(row.consecutive_failures, attempt);
    assert.equal(row.status, attempt === 3 ? 'failed' : 'queued');
  }
});

test('unique conflict bulk upsert idempoten dan memperbarui baris yang sama', async () => {
  const locationId = 18001;
  const transactionId = 18001001;
  await syncSalesTransactionReportsPage(locationId, [sale(locationId, transactionId, 10)], prisma);
  await syncSalesTransactionReportsPage(locationId, [sale(locationId, transactionId, 25)], prisma);
  const rows = await prisma.customerSalesTransactionReport.findMany({
    where: { source_location_id: locationId, runchise_sales_transaction_id: transactionId },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].penambahan_poin, 25);
});

test('cleanup customer menghapus seluruh child eksplisit dan mempertahankan POS via SetNull', async () => {
  const fixture = await redemptionFixture({ available: 100, points: 10 });
  await prisma.pointHistory.create({
    data: {
      customer_id: fixture.customer.id,
      reward_redemption_id: fixture.redemption.id,
      points_change: -10,
      type: 'redeem',
    },
  });
  await prisma.session.create({
    data: { user_id: fixture.user.id, token: unique('session'), expires_at: new Date(Date.now() + 60_000) },
  });
  await prisma.accountActivationToken.create({
    data: { user_id: fixture.user.id, token_hash: unique('activation'), expires_at: new Date(Date.now() + 60_000) },
  });
  const pos = await prisma.runchisePosRewardRedemption.create({
    data: {
      sale_transaction_id: 19000001 + sequence,
      sale_detail_transaction_id: 19010001 + sequence,
      runchise_product_id: 1,
      customer_id: fixture.customer.id,
      product_name: 'SetNull fixture',
      location_id: 19001,
      redeemed_at: new Date(),
      quantity: 1,
      point_per_item: 10,
      points_spent: 10,
      selling_price: 10000,
    },
  });
  const res = responseMock();
  await deleteAdminCustomer({
    params: { id: String(fixture.customer.id) },
    user: { id: null, role: 'admin' },
    get: () => null,
    ip: '127.0.0.1',
  }, res);
  assert.equal(res.statusCode, 200);
  const [customer, user, points, histories, redemptions, sessions, tokens, retained] = await Promise.all([
    prisma.customer.findUnique({ where: { id: fixture.customer.id } }),
    prisma.user.findUnique({ where: { id: fixture.user.id } }),
    prisma.customerPoint.count({ where: { customer_id: fixture.customer.id } }),
    prisma.pointHistory.count({ where: { customer_id: fixture.customer.id } }),
    prisma.rewardRedemption.count({ where: { customer_id: fixture.customer.id } }),
    prisma.session.count({ where: { user_id: fixture.user.id } }),
    prisma.accountActivationToken.count({ where: { user_id: fixture.user.id } }),
    prisma.runchisePosRewardRedemption.findUnique({ where: { id: pos.id } }),
  ]);
  assert.equal(customer, null);
  assert.equal(user, null);
  assert.deepEqual([points, histories, redemptions, sessions, tokens], [0, 0, 0, 0, 0]);
  assert.ok(retained);
  assert.equal(retained.customer_id, null);
});

test('worker melanjutkan outlet dan halaman persis dari cursor persisten', async () => {
  const created = await prisma.salesTransactionSyncJob.create({
    data: { location_ids: [20001, 20002], current_location: 20001, status: 'running' },
  });
  const firstConnection = new Client({ connectionString });
  await firstConnection.connect();
  const first = await processSalesPage(firstConnection, created, {
    fetchPage: async () => ({ sales_transactions: [{}], paging: { next_page: 2 } }),
    syncPage: async () => ({ processed: 1, synced: 1, skipped: 0 }),
  });
  await firstConnection.end();
  assert.equal(first.job.current_location, 20001);
  assert.equal(first.job.current_page, 2);

  const resumed = await prisma.salesTransactionSyncJob.findUnique({ where: { id: created.id } });
  const secondConnection = new Client({ connectionString });
  await secondConnection.connect();
  const second = await processSalesPage(secondConnection, resumed, {
    fetchPage: async (page, params) => {
      assert.equal(page, 2);
      assert.equal(params.location_id, 20001);
      return { sales_transactions: [{}], paging: { next_page: null } };
    },
    syncPage: async () => ({ processed: 1, synced: 1, skipped: 0 }),
  });
  await secondConnection.end();
  assert.equal(second.job.current_location, 20002);
  assert.equal(second.job.current_page, 1);
  assert.equal(second.job.pages_processed, 2);
});

test('kegagalan setelah statement pertama rollback, cursor tetap, lalu retry berhasil', async () => {
  const locationId = 21001;
  const transactionId = 21001001;
  await syncSalesTransactionReportsPage(locationId, [sale(locationId, transactionId, 10)], prisma);
  const job = await prisma.salesTransactionSyncJob.create({
    data: { location_ids: [locationId], current_location: locationId, current_page: 1, status: 'running' },
  });
  const client = new Client({ connectionString });
  await client.connect();
  const fetchPage = async () => ({
    sales_transactions: [sale(locationId, transactionId, 30)],
    paging: { next_page: null },
  });

  await assert.rejects(
    processSalesPage(client, job, {
      fetchPage,
      syncPage: async () => {
        await prisma.$transaction(async (tx) => {
          await tx.customerSalesTransactionReport.deleteMany({
            where: { source_location_id: locationId, runchise_sales_transaction_id: transactionId },
          });
          throw new Error('synthetic failure after first statement');
        });
      },
    }),
    /synthetic failure/,
  );
  const unchanged = await prisma.salesTransactionSyncJob.findUnique({ where: { id: job.id } });
  assert.equal(unchanged.current_page, 1);
  assert.equal(unchanged.pages_processed, 0);
  assert.equal(await prisma.customerSalesTransactionReport.count({
    where: { source_location_id: locationId, runchise_sales_transaction_id: transactionId },
  }), 1);

  const retried = await processSalesPage(client, unchanged, {
    fetchPage,
    syncPage: (activeLocation, sales) => syncSalesTransactionReportsPage(activeLocation, sales, prisma),
  });
  await client.end();
  assert.equal(retried.completed, true);
  assert.equal(retried.job.current_page, 1);
  assert.equal(retried.job.pages_processed, 1);
  const report = await prisma.customerSalesTransactionReport.findFirst({
    where: { source_location_id: locationId, runchise_sales_transaction_id: transactionId },
  });
  assert.equal(report.penambahan_poin, 30);
});

// "RateLimitCounter"."key" adalah PRIMARY KEY, jadi kunci kuota login ikut
// masuk index btree PostgreSQL. Batasnya nyata (bukan teori): index row yang
// melebihi ~8kb ditolak, dan karena express.json menerima body sampai 100kb
// sementara limiter berjalan SEBELUM validasi, kunci tak terbatas membuat
// /login membalas 500 hanya dengan satu request anonim.
test('kunci rate limit login muat di PRIMARY KEY btree walau body bermusuhan', async () => {
  // Digit deterministik tapi tidak berpola (LCG). Penting: deretan berpola
  // seperti "0123456789..." dikompres TOAST sampai muat di index, sehingga
  // test yang memakainya lulus karena keberuntungan kompresi, bukan karena
  // panjang kuncinya benar-benar dibatasi.
  let lcg = 1;
  const hostileDigits = Array.from({ length: 60_000 }, () => {
    lcg = (lcg * 1_103_515_245 + 12_345) % 2_147_483_648;
    return String(lcg % 10);
  }).join('');
  const hostileBody = { phone_number: hostileDigits };

  const key = loginAccountKey({ body: hostileBody });
  const storeKey = `login-account:${key}:${unique('hostile')}`;
  const expiresAt = new Date(Date.now() + 60_000);

  await prisma.$executeRaw`
    INSERT INTO "RateLimitCounter" ("key", "hits", "expires_at")
    VALUES (${storeKey}, 1, ${expiresAt})
  `;
  const stored = await prisma.rateLimitCounter.findUnique({ where: { key: storeKey } });
  assert.equal(stored.hits, 1);

  // Nilai mentah yang sama -- bentuk kunci sebelum diperbaiki -- justru ditolak
  // PostgreSQL. Ini yang membuat pembatasan panjang wajib ada, bukan sekadar
  // kerapian.
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "RateLimitCounter" ("key", "hits", "expires_at")
      VALUES (${`login-account:${hostileDigits}`}, 1, ${expiresAt})
    `,
    (error) => /index row/i.test(String(error.message)),
    'kunci tanpa batas panjang seharusnya ditolak index btree',
  );

  await prisma.$executeRaw`DELETE FROM "RateLimitCounter" WHERE "key" = ${storeKey}`;
});
