// M-12: Menambahkan pengujian integrasi pada jalur kredit/pemakaian poin untuk memastikan transisi status redemption dan penyesuaian poin tetap berjalan sesuai aturan secara atomik serta mencegah regresi sebelum masuk ke production.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-node-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const {
  updateRedemptionStatus,
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

function request(id, status) {
  return {
    params: { id: String(id) },
    body: { status },
    user: { id: 1, role: 'admin' },
    get: () => null,
    ip: '127.0.0.1',
  };
}

// M-12: Membangun mock transaksi Prisma untuk mensimulasikan proses transaksi, merekam setiap operasi, dan memvalidasi perubahan data reward redemption sebelum transisi diterapkan.
function makeFakeTx({
  redemptionRow,
  currentAvailablePoint = 0,
  customerPointRowExists = true,
}) {
  const calls = {
    customerPointFindUnique: null,
    customerPointUpdate: null,
    customerPointUpsert: null,
    pointHistoryCreate: null,
    rewardRedemptionUpdate: null,
    // M-5: jejak query mentah, dipakai untuk membuktikan baris CustomerPoint
    // benar-benar dikunci FOR UPDATE sebelum saldonya dibaca.
    rawQueries: [],
  };

  const tx = {
    // M-5: Memperbarui mock agar dapat membedakan query RewardRedemption dan CustomerPoint pada proses penguncian transaksi.
    async $queryRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      calls.rawQueries.push({ sql, values });

      if (sql.includes('"CustomerPoint"')) {
        if (!customerPointRowExists) return [];
        return [{ available_point: currentAvailablePoint }];
      }
      return [redemptionRow];
    },
    customerPoint: {
      async findUnique(args) {
        calls.customerPointFindUnique = args;
        return {
          customer_id: redemptionRow.customer_id,
          available_point: currentAvailablePoint,
        };
      },
      async update(args) {
        calls.customerPointUpdate = args;
        return {};
      },
      async upsert(args) {
        calls.customerPointUpsert = args;
        return {};
      },
    },
    pointHistory: {
      async create(args) {
        calls.pointHistoryCreate = args;
        return { id: 1 };
      },
    },
    rewardRedemption: {
      async update(args) {
        calls.rewardRedemptionUpdate = args;
        return {
          id: redemptionRow.id,
          status: args.data.status,
          redeemed_at: args.data.redeemed_at,
          reward: { id: 1, name: 'Test Reward' },
          customer: {
            id: redemptionRow.customer_id,
            name: 'Test Customer',
            phone_number: null,
          },
        };
      },
    },
  };

  return { tx, calls };
}

function installTransactionMock(
  t,
  { redemptionRow, currentAvailablePoint, customerPointRowExists },
) {
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = prisma.adminActivityLog.create;
  const { tx, calls } = makeFakeTx({
    redemptionRow,
    currentAvailablePoint,
    customerPointRowExists,
  });

  t.after(() => {
    prisma.$transaction = originalTransaction;
    prisma.adminActivityLog.create = originalAuditCreate;
  });

  prisma.$transaction = async (callback) => callback(tx);
  prisma.adminActivityLog.create = async () => ({ id: 1 });

  return calls;
}

test('pending -> claimed dengan poin cukup: mendebit available_point dan mencatat PointHistory redeem', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 501,
      status: 'pending',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 200,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(501, 'claimed'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'claimed');
  assert.ok(res.body.redeemed_at instanceof Date);
  assert.deepEqual(calls.customerPointUpdate.where, { customer_id: 42 });
  assert.deepEqual(calls.customerPointUpdate.data, {
    available_point: { decrement: 150 },
  });
  assert.equal(calls.pointHistoryCreate.data.points_change, -150);
  assert.equal(calls.pointHistoryCreate.data.type, 'redeem');
  assert.equal(calls.pointHistoryCreate.data.reward_redemption_id, 501);
});

test('pending -> claimed dengan poin TIDAK cukup: ditolak 400, tidak ada satu pun statement tulis yang jalan', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 502,
      status: 'pending',
      points_spent: 9999,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 200,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(502, 'claimed'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak cukup/);
  assert.equal(calls.customerPointUpdate, null);
  assert.equal(calls.pointHistoryCreate, null);
  assert.equal(calls.rewardRedemptionUpdate, null);
});

test('claimed -> expired (void): me-refund available_point dan mencatat PointHistory redeem_refund', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 503,
      status: 'claimed',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: new Date('2026-01-01T00:00:00.000Z'),
    },
    currentAvailablePoint: 50,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(503, 'expired'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'expired');
  // redeemed_at historis dipertahankan, bukan dihapus -- inilah persis
  // skenario yang disebut laporan asli M-5 (redeemed_at hilang saat status
  // berubah).
  assert.deepEqual(res.body.redeemed_at, new Date('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(calls.customerPointUpsert.update, {
    available_point: { increment: 150 },
  });
  assert.equal(calls.pointHistoryCreate.data.points_change, 150);
  assert.equal(calls.pointHistoryCreate.data.type, 'redeem_refund');
});

test('claimed -> pending DITOLAK (skenario persis yang dilaporkan sebagai bug asli)', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 504,
      status: 'claimed',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: new Date(),
    },
    currentAvailablePoint: 50,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(504, 'pending'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak diizinkan/);
  assert.equal(calls.rewardRedemptionUpdate, null);
});

test('expired bersifat terminal: expired -> claimed ditolak', async (t) => {
  installTransactionMock(t, {
    redemptionRow: {
      id: 505,
      status: 'expired',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: new Date(),
    },
    currentAvailablePoint: 50,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(505, 'claimed'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak diizinkan/);
});

test('transisi ke status yang sama ditolak (mencegah statement poin berjalan dua kali)', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 506,
      status: 'pending',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 200,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(506, 'pending'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /sudah berstatus/);
  assert.equal(calls.customerPointUpdate, null);
});

test('pending -> expired (tidak pernah diklaim): tidak ada penyesuaian poin sama sekali', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 507,
      status: 'pending',
      points_spent: 150,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 200,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(507, 'expired'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.customerPointUpdate, null);
  assert.equal(calls.customerPointUpsert, null);
  assert.equal(calls.pointHistoryCreate, null);
});

// ===================== M-5: kunci baris saldo saat klaim =====================
//
// M-5: Memastikan saldo CustomerPoint dikunci dengan FOR UPDATE sebelum pengecekan kecukupan untuk mencegah race condition pada klaim redemption bersamaan.

function customerPointQueries(calls) {
  return calls.rawQueries.filter((query) =>
    query.sql.includes('"CustomerPoint"'),
  );
}

test('M-5: saldo dibaca dengan FOR UPDATE pada baris CustomerPoint milik customer terkait', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 601,
      status: 'pending',
      points_spent: 60,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 100,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(601, 'claimed'), res);

  assert.equal(res.statusCode, 200);

  const pointQueries = customerPointQueries(calls);
  assert.equal(
    pointQueries.length,
    1,
    'harus ada tepat satu pembacaan saldo terkunci',
  );
  assert.match(
    pointQueries[0].sql,
    /FOR UPDATE/,
    'pembacaan saldo wajib memakai FOR UPDATE, bukan SELECT biasa',
  );
  // Kunci harus menyasar baris customer yang benar, bukan seluruh tabel.
  assert.deepEqual(pointQueries[0].values, [42]);
});

test('M-5: baris saldo dikunci SEBELUM baris redemption di-update (bukan setelah)', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 602,
      status: 'pending',
      points_spent: 60,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 100,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(602, 'claimed'), res);
  assert.equal(res.statusCode, 200);

  const order = calls.rawQueries.map((query) =>
    query.sql.includes('"CustomerPoint"') ? 'lock-point' : 'lock-redemption',
  );
  assert.deepEqual(
    order,
    ['lock-redemption', 'lock-point'],
    'urutan kunci harus RewardRedemption lalu CustomerPoint agar konsisten dengan jalur lain',
  );
});

test('M-5: cek kecukupan memakai nilai hasil kunci, findUnique tak terkunci tidak dipakai lagi', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 603,
      status: 'pending',
      points_spent: 60,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 100,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(603, 'claimed'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    calls.customerPointFindUnique,
    null,
    'jalur klaim tidak boleh lagi membaca saldo lewat findUnique yang tidak mengunci',
  );
});

test('M-5: saldo persis pas (available === points_spent) tetap diizinkan dan tidak membuat minus', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 604,
      status: 'pending',
      points_spent: 100,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 100,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(604, 'claimed'), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.customerPointUpdate.data, {
    available_point: { decrement: 100 },
  });
});

test('M-5: kurang satu poin dari kebutuhan ditolak, saldo tidak disentuh sama sekali', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 605,
      status: 'pending',
      points_spent: 100,
      customer_id: 42,
      redeemed_at: null,
    },
    currentAvailablePoint: 99,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(605, 'claimed'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.customerPointUpdate, null);
  assert.equal(calls.pointHistoryCreate, null);
  assert.equal(calls.rewardRedemptionUpdate, null);
});

test('M-5: customer tanpa baris CustomerPoint diperlakukan sebagai saldo 0, bukan lolos diam-diam', async (t) => {
  const calls = installTransactionMock(t, {
    redemptionRow: {
      id: 606,
      status: 'pending',
      points_spent: 50,
      customer_id: 42,
      redeemed_at: null,
    },
    customerPointRowExists: false,
  });

  const res = responseMock();
  await updateRedemptionStatus(request(606, 'claimed'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak cukup/i);
  assert.equal(
    calls.customerPointUpdate,
    null,
    'tidak boleh ada pengurangan saldo',
  );
});
