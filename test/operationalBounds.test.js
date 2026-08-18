const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const promoRouter = require('../src/routes/promoRoutes');
const {
  listAdminBrands,
  listAdminLocations,
} = require('../src/controllers/adminLoyalty/adminCustomerController');
const {
  listCustomerSalesTransactionReportOutlets,
} = require('../src/controllers/adminLoyalty/salesTransactionReportController');

function responseMock() {
  return {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('promo aktif mengikuti window runtime, bukan hanya status hasil sync', () => {
  const now = new Date('2026-08-20T17:00:00.000Z');
  const where = promoRouter.buildPromoWhere('active', now);
  const temporal = where.AND[0].OR[1].AND;
  assert.deepEqual(temporal[0], {
    OR: [{ start_at: null }, { start_at: { lte: now } }],
  });
  assert.deepEqual(temporal[1], {
    OR: [{ end_at: null }, { end_at: { gte: now } }],
  });
});

test('dropdown admin dan daftar outlet memiliki batas query eksplisit', async (t) => {
  const originalBrandFindMany = prisma.brand.findMany;
  const originalLocationFindMany = prisma.location.findMany;
  const originalReportFindMany = prisma.customerSalesTransactionReport.findMany;
  const calls = [];
  prisma.brand.findMany = async (args) => { calls.push(['brand', args]); return []; };
  prisma.location.findMany = async (args) => { calls.push(['location', args]); return []; };
  prisma.customerSalesTransactionReport.findMany = async (args) => {
    calls.push(['outlets', args]);
    return [];
  };
  t.after(() => {
    prisma.brand.findMany = originalBrandFindMany;
    prisma.location.findMany = originalLocationFindMany;
    prisma.customerSalesTransactionReport.findMany = originalReportFindMany;
  });

  await listAdminBrands({}, responseMock());
  await listAdminLocations({}, responseMock());
  const outletResponse = responseMock();
  await listCustomerSalesTransactionReportOutlets({}, outletResponse);

  assert.equal(calls.find(([kind]) => kind === 'brand')[1].take, 1000);
  assert.equal(calls.find(([kind]) => kind === 'location')[1].take, 1000);
  assert.equal(calls.find(([kind]) => kind === 'outlets')[1].take, 1000);
  // Endpoint outlet berada di belakang auth + role. Boleh disimpan cache
  // privat milik browser pemanggil, tetapi TIDAK boleh masuk shared cache:
  // cookie sesi bukan bagian cache key di edge, sehingga respons untuk sesi
  // yang sudah login bisa terlayani ke permintaan anonim pada path yang sama.
  assert.equal(outletResponse.headers['Cache-Control'], 'private, max-age=300');
  assert.doesNotMatch(outletResponse.headers['Cache-Control'], /s-maxage=/);
  assert.doesNotMatch(outletResponse.headers['Cache-Control'], /(^|[ ,])public/);
  assert.equal(outletResponse.headers['CDN-Cache-Control'], 'private, no-store');
  assert.equal(
    outletResponse.headers['Vercel-CDN-Cache-Control'],
    'private, no-store',
  );
});
