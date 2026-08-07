const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRedeemItemCreate,
  validateRedeemItemId,
  validateRedeemItemUpdate,
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
