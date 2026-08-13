// H-2 (residual): membuktikan kebijakan TTL benar-benar terpasang di middleware
// auth, bukan hanya benar sebagai fungsi murni di sessionPolicy.
process.env.JWT_SECRET ||= 'session-sliding-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const auth = require('../src/middleware/auth');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    clearCookie(name) {
      this.clearedCookies.push(name);
      return this;
    },
  };
}

function signToken({ id = 7, role = 'admin', expiresIn = '24h' } = {}) {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn });
}

function requestWith(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

// Mengganti dua method prisma yang dipakai middleware, lalu memulihkannya.
function installSessionMock(t, { session }) {
  const originalFindUnique = prisma.session.findFirst;
  const originalUpdate = prisma.session.update;
  const updates = [];

  prisma.session.findFirst = async () => ({ token: 'persisted-hash', ...session });
  prisma.session.update = async (args) => {
    updates.push(args);
    return { id: 1 };
  };

  t.after(() => {
    prisma.session.findFirst = originalFindUnique;
    prisma.session.update = originalUpdate;
  });

  return updates;
}

test('sesi admin lama bertenor 7 hari diperpendek ke kebijakan baru saat dipakai', async (t) => {
  const token = signToken({ role: 'admin', expiresIn: '7d' });
  const updates = installSessionMock(t, {
    session: { user_id: 7, expires_at: new Date(Date.now() + 7 * DAY) },
  });

  let nextCalled = false;
  await auth(requestWith(token), responseMock(), () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(updates.length, 1);

  const newExpiry = updates[0].data.expires_at.getTime();
  assert.ok(
    newExpiry < Date.now() + DAY,
    'sesi staff seharusnya tidak lagi berlaku berhari-hari',
  );
  assert.ok(newExpiry > Date.now() + 7 * HOUR);
});

test('sesi customer yang sudah menempel di batas absolut tidak memicu UPDATE', async (t) => {
  const token = signToken({ role: 'customer', expiresIn: '7d' });
  const decoded = jwt.decode(token);
  const updates = installSessionMock(t, {
    session: { user_id: 7, expires_at: new Date(decoded.exp * 1000) },
  });

  let nextCalled = false;
  await auth(requestWith(token), responseMock(), () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(updates.length, 0, 'jalur customer tidak boleh menambah beban tulis');
});

test('sesi yang idle-nya sudah lewat ditolak walau token JWT-nya belum kedaluwarsa', async (t) => {
  const token = signToken({ role: 'admin', expiresIn: '24h' });
  installSessionMock(t, {
    session: { user_id: 7, expires_at: new Date(Date.now() - MINUTE) },
  });

  const res = responseMock();
  let nextCalled = false;
  await auth(requestWith(token), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('kegagalan memperpanjang sesi tidak menggagalkan request yang sudah sah', async (t) => {
  const token = signToken({ role: 'admin', expiresIn: '24h' });
  const originalFindUnique = prisma.session.findFirst;
  const originalUpdate = prisma.session.update;
  const originalConsoleError = console.error;

  t.after(() => {
    prisma.session.findFirst = originalFindUnique;
    prisma.session.update = originalUpdate;
    console.error = originalConsoleError;
  });

  prisma.session.findFirst = async () => ({
    token: 'persisted-hash',
    user_id: 7,
    expires_at: new Date(Date.now() + 30 * MINUTE),
  });
  prisma.session.update = async () => {
    throw new Error('database sedang tidak bisa menulis');
  };
  console.error = () => {};

  const res = responseMock();
  let nextCalled = false;
  await auth(requestWith(token), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});
