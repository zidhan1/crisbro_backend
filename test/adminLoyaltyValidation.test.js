const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAdminUserCreate,
  validateAdminUserList,
  validateAdminUserUpdate,
  validateCustomerCreate,
  validateCustomerList,
  validateCustomerUpdate,
  validateIdParam,
  validateLoyaltyAdjustment,
  validateLoyaltySummary,
  validateRedeemItemCreate,
  validateRedeemItemId,
  validateRedeemItemList,
  validateRedeemItemUpdate,
  validateRedemptionStatusUpdate,
  validateRewardCreate,
  validateSalesTransactionReportList,
} = require('../src/middleware/adminLoyaltyValidation');

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function run(middleware, req) {
  const res = responseMock();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('schema create redeem menerima payload valid dari boundary HTTP', () => {
  const { res, nextCalled } = run(validateRedeemItemCreate, {
    body: {
      menu_item_id: '10',
      points_required: '2000',
      is_active: 'true',
      start_at: '2026-08-07T00:00:00.000Z',
    },
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('schema create redeem menolak field liar sebelum controller/database', () => {
  const { res, nextCalled } = run(validateRedeemItemCreate, {
    body: {
      menu_item_id: 10,
      points_required: 2000,
      is_admin: true,
    },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Request tidak valid/);
});

test('schema update menolak body kosong dan ID non-positif', () => {
  const emptyUpdate = run(validateRedeemItemUpdate, {
    params: { id: '1' },
    body: {},
  });
  assert.equal(emptyUpdate.nextCalled, false);
  assert.equal(emptyUpdate.res.statusCode, 400);

  const invalidId = run(validateRedeemItemId, {
    params: { id: '0' },
  });
  assert.equal(invalidId.nextCalled, false);
  assert.equal(invalidId.res.statusCode, 400);
});

// ===================== L-7: cakupan boundary di luar rute redeem =====================

test('L-7: pagination liar ditolak sebelum controller di semua list endpoint', () => {
  const cases = [
    [validateAdminUserList, { query: { page: '0' } }],
    [validateCustomerList, { query: { limit: '-5' } }],
    [validateSalesTransactionReportList, { query: { page: 'abc' } }],
    [validateRedeemItemList, { query: { limit: '0' } }],
    [validateLoyaltySummary, { query: { redemption_history_page: '0' } }],
  ];

  for (const [middleware, req] of cases) {
    const { res, nextCalled } = run(middleware, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Request tidak valid/);
  }
});

test('L-7: query list yang wajar tetap diteruskan apa adanya', () => {
  const users = run(validateAdminUserList, {
    query: { search: 'budi', sort_by: 'role', sort_order: 'asc', page: '2', limit: '50' },
  });
  assert.equal(users.nextCalled, true);

  const customers = run(validateCustomerList, {
    query: {
      search: 'budi',
      email_status: 'missing',
      from: '2026-01-01',
      to: '2026-02-01',
      page: '1',
      limit: '20',
    },
  });
  assert.equal(customers.nextCalled, true);
});

// H-1 mensyaratkan endpoint profil TETAP menerima field poin/saldo lalu
// mengabaikannya sambil mencatat percobaannya ke audit log. Kalau boundary
// menolaknya, perilaku yang dirancang H-1 ikut mati -- karena itu dikunci test.
test('L-7 tidak mematikan H-1: field poin/saldo tetap lolos boundary customer', () => {
  const payload = {
    name: 'Budi',
    phone_number: '81234567890',
    email: 'budi@example.com',
    brand_id: 1,
    owner_location_id: 7,
    location_ids: [7],
    balance: 15000,
    total_point: 900,
    available_point: 250,
  };

  const create = run(validateCustomerCreate, { body: payload });
  assert.equal(create.nextCalled, true);

  const update = run(validateCustomerUpdate, {
    params: { id: '12' },
    body: payload,
  });
  assert.equal(update.nextCalled, true);
});

test('L-7: mutasi poin lewat endpoint khusus menolak field liar dan reason kosong', () => {
  const valid = run(validateLoyaltyAdjustment, {
    params: { id: '12' },
    body: { reason: 'koreksi manual kasir', available_point: 100 },
  });
  assert.equal(valid.nextCalled, true);

  const wildField = run(validateLoyaltyAdjustment, {
    params: { id: '12' },
    body: { reason: 'koreksi', role: 'admin' },
  });
  assert.equal(wildField.nextCalled, false);
  assert.equal(wildField.res.statusCode, 400);

  const negativePoint = run(validateLoyaltyAdjustment, {
    params: { id: '12' },
    body: { reason: 'koreksi', available_point: -1 },
  });
  assert.equal(negativePoint.nextCalled, false);
  assert.equal(negativePoint.res.statusCode, 400);
});

// updateAdminUser punya guard field liar sendiri beserta pesannya
// ("Field tidak diizinkan: ..."), jadi boundary sengaja passthrough supaya
// pesan itu tidak tergantikan pesan zod.
test('L-7: update user admin membiarkan guard field liar milik controller bekerja', () => {
  const { nextCalled } = run(validateAdminUserUpdate, {
    params: { id: '3' },
    body: { role: 'admin', is_superuser: true },
  });
  assert.equal(nextCalled, true);
});

test('L-7: body create yang tertutup menolak field liar', () => {
  const user = run(validateAdminUserCreate, {
    body: { email: 'a@b.com', password: 'rahasia123', role: 'admin', is_root: true },
  });
  assert.equal(user.nextCalled, false);
  assert.equal(user.res.statusCode, 400);

  const reward = run(validateRewardCreate, {
    body: { name: 'Voucher', points_required: 100, injected: 'x' },
  });
  assert.equal(reward.nextCalled, false);
  assert.equal(reward.res.statusCode, 400);

  const redemption = run(validateRedemptionStatusUpdate, {
    params: { id: '5' },
    body: { status: 'claimed', force: true },
  });
  assert.equal(redemption.nextCalled, false);
  assert.equal(redemption.res.statusCode, 400);
});

test('L-7: param :id divalidasi untuk endpoint efek samping tanpa body', () => {
  assert.equal(run(validateIdParam, { params: { id: '9' } }).nextCalled, true);
  assert.equal(run(validateIdParam, { params: { id: 'abc' } }).nextCalled, false);
});
