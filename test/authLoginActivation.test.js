// M-12: Menambahkan pengujian integrasi pada jalur login/aktivasi untuk memastikan respons tetap konsisten pada seluruh kondisi autentikasi serta mencegah kebocoran informasi akun dan akses dari akun yang belum diaktivasi.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-node-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { login, activateAccount } = require('../src/controllers/authController');

// Menggunakan hash bcrypt asli untuk memastikan proses verifikasi password diuji melalui mekanisme autentikasi yang sebenarnya, bukan hasil mock.
const REAL_PASSWORD = 'correct-horse-battery';
const REAL_PASSWORD_HASH =
  '$2b$10$gVjmOy9gLnD56G5XBbina.bTOB6lJQ7re9IuV2nHdCI.I3M8XHJ.u';

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    cookieCalls: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    cookie(name, value, options) {
      this.cookieCalls.push({ name, value, options });
      return this;
    },
  };
}

function loginRequest(body) {
  return { body, get: () => null };
}

test('login: password salah ditolak dengan pesan seragam, tanpa membuat sesi', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  const originalSessionCreate = prisma.session.create;
  let sessionCreated = false;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
    prisma.session.create = originalSessionCreate;
  });

  prisma.user.findUnique = async () => ({
    id: 1,
    role: 'customer',
    password_hash: REAL_PASSWORD_HASH,
    activation_status: 'active',
  });
  prisma.session.create = async () => {
    sessionCreated = true;
  };

  const res = responseMock();
  await login(
    loginRequest({ phone_number: '81234567890', password: 'password-salah' }),
    res,
  );

  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Nomor telepon atau password salah/);
  assert.equal(sessionCreated, false);
});

test('login: nomor tidak terdaftar dibalas PERSIS sama seperti password salah (tidak membocorkan status)', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
  });
  prisma.user.findUnique = async () => null;

  const res = responseMock();
  await login(
    loginRequest({ phone_number: '89999999999', password: 'apa-saja' }),
    res,
  );

  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Nomor telepon atau password salah/);
});

test('login: akun pending_activation ditolak walau password (calon) benar', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
  });

  // password_hash kosong -- pola user hasil sinkronisasi Runchise yang
  // belum pernah mengaktivasi akun (lihat isSyncedPlaceholderUser).
  prisma.user.findUnique = async () => ({
    id: 2,
    role: 'customer',
    password_hash: '',
    activation_status: 'pending_activation',
  });

  const res = responseMock();
  await login(
    loginRequest({ phone_number: '81234567890', password: REAL_PASSWORD }),
    res,
  );

  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Nomor telepon atau password salah/);
});

test('login: kredensial benar pada akun aktif -> sesi dibuat, cookie di-set, password_hash tidak ikut terkirim', async (t) => {
  const originalFindUnique = prisma.user.findUnique;
  const originalSessionCreate = prisma.session.create;
  let findUniqueCallCount = 0;
  let sessionCreateArgs = null;
  t.after(() => {
    prisma.user.findUnique = originalFindUnique;
    prisma.session.create = originalSessionCreate;
  });

  prisma.user.findUnique = async (args) => {
    findUniqueCallCount += 1;
    // Panggilan pertama: verifikasi kredensial (kolom minimal).
    if (findUniqueCallCount === 1) {
      assert.equal(args.where.phone_number, '81234567890');
      return {
        id: 7,
        role: 'customer',
        password_hash: REAL_PASSWORD_HASH,
        activation_status: 'active',
      };
    }
    // Panggilan kedua: memuat profil lengkap setelah kredensial terbukti.
    assert.equal(args.where.id, 7);
    return {
      id: 7,
      role: 'customer',
      password_hash: REAL_PASSWORD_HASH,
      activation_status: 'active',
      email: null,
      phone_number: '81234567890',
      customer: {
        id: 100,
        name: 'Test Customer',
        customer_point: { available_point: 50 },
      },
    };
  };
  prisma.session.create = async (args) => {
    sessionCreateArgs = args;
    return { id: 1 };
  };

  const res = responseMock();
  await login(
    loginRequest({ phone_number: '81234567890', password: REAL_PASSWORD }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(findUniqueCallCount, 2);
  assert.equal(sessionCreateArgs.data.user_id, 7);
  assert.equal(typeof sessionCreateArgs.data.token, 'string');
  assert.equal(res.cookieCalls.length, 1);
  assert.equal(res.cookieCalls[0].name, 'crisbar_session');
  assert.equal(res.body.user.password_hash, undefined);
  assert.equal(res.body.user.id, 7);
});

test('activateAccount: token tidak valid/tidak ditemukan ditolak', async (t) => {
  const originalFind = prisma.accountActivationToken.findUnique;
  t.after(() => {
    prisma.accountActivationToken.findUnique = originalFind;
  });
  prisma.accountActivationToken.findUnique = async () => null;

  const res = responseMock();
  await activateAccount(
    { body: { token: 'tidak-ada', password: 'password-baru-123' } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak valid atau sudah kedaluwarsa/);
});

test('activateAccount: token sudah kedaluwarsa ditolak', async (t) => {
  const originalFind = prisma.accountActivationToken.findUnique;
  t.after(() => {
    prisma.accountActivationToken.findUnique = originalFind;
  });
  prisma.accountActivationToken.findUnique = async () => ({
    id: 1,
    user_id: 10,
    used_at: null,
    expires_at: new Date(Date.now() - 1000), // sudah lewat
    user: { activation_status: 'pending_activation' },
  });

  const res = responseMock();
  await activateAccount(
    { body: { token: 'kadaluwarsa', password: 'password-baru-123' } },
    res,
  );

  assert.equal(res.statusCode, 400);
});

test('activateAccount: token sudah pernah dipakai ditolak', async (t) => {
  const originalFind = prisma.accountActivationToken.findUnique;
  t.after(() => {
    prisma.accountActivationToken.findUnique = originalFind;
  });
  prisma.accountActivationToken.findUnique = async () => ({
    id: 1,
    user_id: 10,
    used_at: new Date(), // sudah dipakai
    expires_at: new Date(Date.now() + 60000),
    user: { activation_status: 'pending_activation' },
  });

  const res = responseMock();
  await activateAccount(
    { body: { token: 'sudah-dipakai', password: 'password-baru-123' } },
    res,
  );

  assert.equal(res.statusCode, 400);
});

test('activateAccount: token valid -> set password, tandai token terpakai, cabut semua sesi lama dalam satu transaksi', async (t) => {
  const originalFind = prisma.accountActivationToken.findUnique;
  const originalTransaction = prisma.$transaction;
  t.after(() => {
    prisma.accountActivationToken.findUnique = originalFind;
    prisma.$transaction = originalTransaction;
  });

  prisma.accountActivationToken.findUnique = async () => ({
    id: 5,
    user_id: 10,
    used_at: null,
    expires_at: new Date(Date.now() + 60000),
    user: { activation_status: 'pending_activation' },
  });

  let capturedOps = null;
  prisma.$transaction = async (ops) => {
    capturedOps = ops;
    return Promise.all(ops);
  };

  // Menggunakan operasi Prisma berbasis mock sebagai penanda agar prisma.$transaction() dapat diuji tanpa mengeksekusi query ke database.
  const originalUserUpdate = prisma.user.update;
  const originalTokenUpdate = prisma.accountActivationToken.update;
  const originalSessionDeleteMany = prisma.session.deleteMany;
  let userUpdateArgs = null;
  let tokenUpdateArgs = null;
  let sessionDeleteArgs = null;
  t.after(() => {
    prisma.user.update = originalUserUpdate;
    prisma.accountActivationToken.update = originalTokenUpdate;
    prisma.session.deleteMany = originalSessionDeleteMany;
  });
  prisma.user.update = (args) => {
    userUpdateArgs = args;
    return Promise.resolve({ id: 10 });
  };
  prisma.accountActivationToken.update = (args) => {
    tokenUpdateArgs = args;
    return Promise.resolve({ id: 5 });
  };
  prisma.session.deleteMany = (args) => {
    sessionDeleteArgs = args;
    return Promise.resolve({ count: 3 });
  };

  const res = responseMock();
  await activateAccount(
    { body: { token: 'token-sah', password: 'password-baru-123' } },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(capturedOps.length, 3);
  assert.equal(userUpdateArgs.where.id, 10);
  assert.equal(userUpdateArgs.data.activation_status, 'active');
  assert.notEqual(userUpdateArgs.data.password_hash, 'password-baru-123');
  assert.equal(tokenUpdateArgs.where.id, 5);
  assert.ok(tokenUpdateArgs.data.used_at instanceof Date);
  assert.equal(sessionDeleteArgs.where.user_id, 10);
});
