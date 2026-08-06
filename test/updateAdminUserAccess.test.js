const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { updateAdminUser } = require('../src/controllers/adminLoyaltyController');

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

function request(body) {
  return {
    params: { id: '42' },
    body,
    user: { id: 1, role: 'admin' },
    get: () => null,
    ip: '127.0.0.1',
  };
}

test('menolak promosi akun customer sebelum transaksi atau hashing dijalankan', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  let transactionCalled = false;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
  });

  prisma.user.findUnique = async () => ({
    id: 42,
    email: 'customer@example.test',
    phone_number: '81234567890',
    role: 'customer',
    created_at: new Date(),
    updated_at: new Date(),
    customer: { id: 99 },
  });
  prisma.$transaction = async () => {
    transactionCalled = true;
  };

  const res = responseMock();
  await updateAdminUser(request({ role: 'admin', password: 'rahasia-baru' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Hanya akun staff/);
  assert.equal(transactionCalled, false);
});

test('menolak field di luar whitelist tanpa mengakses target', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  let findCalled = false;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
  });
  prisma.user.findUnique = async () => {
    findCalled = true;
  };

  const res = responseMock();
  await updateAdminUser(request({ activation_status: 'active' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Field tidak diizinkan/);
  assert.equal(findCalled, false);
});

test('update role staff memakai guard atomik dan mencabut sesi lama', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = prisma.adminActivityLog.create;
  const calls = { updateWhere: null, revoked: false, audit: null };
  const before = {
    id: 42,
    email: 'staff@example.test',
    phone_number: null,
    role: 'admin',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    customer: null,
  };
  const after = { ...before, role: 'marketing', customer: undefined };

  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    prisma.adminActivityLog.create = originalAuditCreate;
  });
  prisma.user.findUnique = async () => before;
  prisma.$transaction = async (callback) =>
    callback({
      user: {
        updateMany: async ({ where }) => {
          calls.updateWhere = where;
          return { count: 1 };
        },
        findUnique: async () => after,
      },
      session: {
        deleteMany: async () => {
          calls.revoked = true;
          return { count: 2 };
        },
      },
    });
  prisma.adminActivityLog.create = async ({ data }) => {
    calls.audit = data;
    return { id: 1 };
  };

  const res = responseMock();
  await updateAdminUser(request({ role: 'marketing' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, 'marketing');
  assert.deepEqual(calls.updateWhere.role.in.sort(), ['admin', 'marketing']);
  assert.deepEqual(calls.updateWhere.customer, { is: null });
  assert.equal(calls.revoked, true);
  assert.equal(calls.audit.metadata.sessions_revoked, true);
});
