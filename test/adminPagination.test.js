process.env.JWT_SECRET ||= 'pagination-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const {
  listAdminUsers,
  listRewards,
} = require('../src/controllers/adminLoyaltyController');
const {
  createRedeemAdminControllers,
} = require('../src/controllers/adminLoyalty/redeemAdminController');

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function parsePositiveInt(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('invalid integer');
  return number;
}

function installModelMock(t, model, total) {
  const originalCount = prisma[model].count;
  const originalFindMany = prisma[model].findMany;
  const calls = [];
  prisma[model].count = async () => total;
  prisma[model].findMany = async (args) => {
    calls.push(args);
    return [{ id: args.skip + 1 }];
  };
  t.after(() => {
    prisma[model].count = originalCount;
    prisma[model].findMany = originalFindMany;
  });
  return calls;
}

test('users dapat mengakses data setelah urutan 1.000 tanpa terpotong', async (t) => {
  const calls = installModelMock(t, 'user', 1_205);
  const res = responseMock();
  await listAdminUsers({ query: { page: '11', limit: '100' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    { page: res.body.page, limit: res.body.limit, total: res.body.total, total_pages: res.body.total_pages },
    { page: 11, limit: 100, total: 1205, total_pages: 13 },
  );
  assert.equal(calls[0].skip, 1000);
  assert.equal(calls[0].take, 100);
});

test('rewards memakai page clamp dan tidak mengembalikan halaman kosong palsu', async (t) => {
  const calls = installModelMock(t, 'rewardsCatalog', 1_205);
  const res = responseMock();
  await listRewards({ query: { page: '999', limit: '100' } }, res);
  assert.equal(res.body.page, 13);
  assert.equal(res.body.total_pages, 13);
  assert.equal(calls[0].skip, 1200);
  assert.equal(calls[0].take, 100);
});

function redeemControllers() {
  return createRedeemAdminControllers({
    prisma,
    parsePositiveInt,
    parseOptionalString: (value) => value || null,
    buildRedeemItemOrderBy: () => [{ id: 'asc' }],
    addRedeemPriceBreakdown: (item) => item,
    handleError: (res, error) => res.status(500).json({ message: error.message }),
    badRequest: (res, message) => res.status(400).json({ message }),
    EXCLUDED_CRISBAR_CATEGORY_NAMES: [],
    getRedeemCatalogConfig: () => ({}),
    normalizeReportName: (value) => value,
    parseRequiredString: String,
    parseBoolean: Boolean,
    parseNonNegativeInt: Number,
    parseOptionalDate: (value) => value,
    getDefaultRedeemCategoryId: async () => 1,
    recordAdminActivity: async () => {},
    getDefaultRewardThreshold: () => 2000,
    REDEEM_ITEM_SELECT: {},
    REDEEM_ITEM_AUDIT_INCLUDE: {},
  });
}

test('redeem categories dan items dapat membaca halaman setelah data ke-1.000', async (t) => {
  const categoryCalls = installModelMock(t, 'redeemMenuCategory', 1_150);
  const itemCalls = installModelMock(t, 'redeemMenuItem', 1_150);
  const controllers = redeemControllers();

  const categoryRes = responseMock();
  await controllers.listRedeemCategories({ query: { page: '11', limit: '100' } }, categoryRes);
  assert.equal(categoryRes.body.page, 11);
  assert.equal(categoryRes.body.total_pages, 12);
  assert.equal(categoryCalls[0].skip, 1000);

  const itemRes = responseMock();
  await controllers.listRedeemItems({ query: { page: '11', limit: '100' } }, itemRes);
  assert.equal(itemRes.body.page, 11);
  assert.equal(itemRes.body.total, 1150);
  assert.equal(itemCalls[0].skip, 1000);
  assert.equal(itemCalls[0].take, 100);
});
