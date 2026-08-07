const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { GENERIC_MESSAGE } = require('../src/lib/serverError');
const {
  listAdminUsers,
} = require('../src/controllers/adminLoyaltyController');

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

test('ValidationError dari parser dikirim sebagai HTTP 400', async () => {
  const res = responseMock();

  await listAdminUsers({ query: { search: { invalid: true } } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'search harus berupa string' });
});

test('error internal yang memuat kata harus tetap dikirim sebagai HTTP 500', async (t) => {
  const originalFindMany = prisma.user.findMany;
  const originalConsoleError = console.error;
  t.after(() => {
    prisma.user.findMany = originalFindMany;
    console.error = originalConsoleError;
  });

  prisma.user.findMany = async () => {
    throw new Error('Koneksi database harus tersedia');
  };
  console.error = () => {};

  const res = responseMock();
  await listAdminUsers({ query: {} }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, GENERIC_MESSAGE);
  assert.match(res.body.error_id, /^[a-f0-9]{8}$/);
  assert.doesNotMatch(res.body.message, /Koneksi database/);
});

test('error internal yang memuat kata wajib tetap dikirim sebagai HTTP 500', async (t) => {
  const originalFindMany = prisma.user.findMany;
  const originalConsoleError = console.error;
  t.after(() => {
    prisma.user.findMany = originalFindMany;
    console.error = originalConsoleError;
  });

  prisma.user.findMany = async () => {
    throw new Error('Konfigurasi database wajib tersedia');
  };
  console.error = () => {};

  const res = responseMock();
  await listAdminUsers({ query: {} }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, GENERIC_MESSAGE);
  assert.match(res.body.error_id, /^[a-f0-9]{8}$/);
});
