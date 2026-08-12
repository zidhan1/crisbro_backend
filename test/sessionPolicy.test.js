// H-2 (residual): mengunci kebijakan masa berlaku sesi -- staff mendapat
// jendela pendek dengan batas absolut, customer tetap seperti sebelumnya, dan
// sesi lama bertenor 7 hari ikut diperpendek saat dipakai lagi.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSessionExpiry,
  computeSlidingSessionExpiry,
  getSessionPolicy,
  isStaffRole,
} = require('../src/lib/sessionPolicy');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function withEnv(vars, run) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('peran staff dikenali terpisah dari customer', () => {
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('marketing'), true);
  assert.equal(isStaffRole('customer'), false);
  assert.equal(isStaffRole(undefined), false);
});

test('sesi staff default: idle 8 jam dengan batas absolut 24 jam', () => {
  withEnv(
    {
      ADMIN_SESSION_IDLE_MINUTES: undefined,
      ADMIN_SESSION_ABSOLUTE_HOURS: undefined,
    },
    () => {
      for (const role of ['admin', 'marketing']) {
        const policy = getSessionPolicy(role);
        assert.equal(policy.idleMs, 8 * HOUR);
        assert.equal(policy.absoluteExpiresIn, '24h');
      }
    },
  );
});

test('JWT_EXPIRES_IN tidak lagi memperpanjang sesi staff', () => {
  withEnv(
    { JWT_EXPIRES_IN: '7d', ADMIN_SESSION_ABSOLUTE_HOURS: undefined },
    () => {
      assert.equal(getSessionPolicy('admin').absoluteExpiresIn, '24h');
      // Knob lama tetap berlaku untuk customer supaya konfigurasi produksi
      // yang sudah ada berarti sama seperti sebelumnya.
      assert.equal(getSessionPolicy('customer').absoluteExpiresIn, '7d');
    },
  );
});

test('sesi customer tidak berubah dari perilaku sebelum perbaikan', () => {
  withEnv(
    { JWT_EXPIRES_IN: undefined, CUSTOMER_SESSION_IDLE_DAYS: undefined },
    () => {
      const policy = getSessionPolicy('customer');
      assert.equal(policy.idleMs, 7 * DAY);
      assert.equal(policy.absoluteExpiresIn, '7d');

      // Idle sama dengan absolut -> expires_at jatuh tepat di exp token, persis
      // seperti implementasi lama.
      const now = Date.now();
      const tokenExpMs = now + 7 * DAY;
      assert.equal(
        computeSessionExpiry({ role: 'customer', now, tokenExpMs }).getTime(),
        tokenExpMs,
      );

      // Karena sudah menempel di plafon, tidak ada UPDATE tambahan per request.
      assert.equal(
        computeSlidingSessionExpiry({
          role: 'customer',
          now: now + HOUR,
          tokenExpMs,
          currentExpiresAt: new Date(tokenExpMs),
        }),
        null,
      );
    },
  );
});

test('sesi staff baru dibatasi idle, bukan batas absolut', () => {
  withEnv({ ADMIN_SESSION_IDLE_MINUTES: undefined }, () => {
    const now = Date.now();
    const tokenExpMs = now + 24 * HOUR;

    assert.equal(
      computeSessionExpiry({ role: 'admin', now, tokenExpMs }).getTime(),
      now + 8 * HOUR,
    );
  });
});

test('aktivitas menggeser batas idle, tetapi tidak pernah melewati batas absolut', () => {
  withEnv({ ADMIN_SESSION_IDLE_MINUTES: undefined }, () => {
    const login = Date.now();
    const tokenExpMs = login + 24 * HOUR;

    // Aktif 30 menit setelah login -> idle digeser maju 30 menit.
    const active = login + 30 * MINUTE;
    const slid = computeSlidingSessionExpiry({
      role: 'admin',
      now: active,
      tokenExpMs,
      currentExpiresAt: new Date(login + 8 * HOUR),
    });
    assert.equal(slid.getTime(), active + 8 * HOUR);

    // Menjelang batas absolut, plafon menang: idle tidak boleh melewati exp.
    const nearEnd = login + 23 * HOUR;
    const capped = computeSlidingSessionExpiry({
      role: 'admin',
      now: nearEnd,
      tokenExpMs,
      currentExpiresAt: new Date(nearEnd),
    });
    assert.equal(capped.getTime(), tokenExpMs);
    assert.ok(capped.getTime() <= tokenExpMs);
  });
});

test('penulisan digeser hanya setelah melewati ambang perpanjangan', () => {
  withEnv(
    {
      ADMIN_SESSION_IDLE_MINUTES: undefined,
      SESSION_RENEW_INTERVAL_MINUTES: undefined,
    },
    () => {
      const now = Date.now();
      const tokenExpMs = now + 24 * HOUR;
      const currentExpiresAt = new Date(now + 8 * HOUR);

      // Request 1 menit kemudian: selisih di bawah ambang 5 menit -> tanpa UPDATE.
      assert.equal(
        computeSlidingSessionExpiry({
          role: 'admin',
          now: now + MINUTE,
          tokenExpMs,
          currentExpiresAt,
        }),
        null,
      );

      // Request 6 menit kemudian: sudah melewati ambang -> ditulis.
      assert.ok(
        computeSlidingSessionExpiry({
          role: 'admin',
          now: now + 6 * MINUTE,
          tokenExpMs,
          currentExpiresAt,
        }),
      );
    },
  );
});

// Tanpa ini, semua sesi staff yang terlanjur dibuat sebelum rilis akan tetap
// memegang jendela 7 hari sampai kedaluwarsa sendiri -- perbaikannya baru
// berlaku untuk login berikutnya saja.
test('sesi staff lama bertenor 7 hari diperpendek saat dipakai lagi', () => {
  withEnv({ ADMIN_SESSION_IDLE_MINUTES: undefined }, () => {
    const now = Date.now();
    const legacyExpiry = new Date(now + 7 * DAY);
    const legacyTokenExpMs = now + 7 * DAY;

    const shortened = computeSlidingSessionExpiry({
      role: 'admin',
      now,
      tokenExpMs: legacyTokenExpMs,
      currentExpiresAt: legacyExpiry,
    });

    assert.equal(shortened.getTime(), now + 8 * HOUR);
    assert.ok(shortened.getTime() < legacyExpiry.getTime());
  });
});

test('token tanpa klaim exp yang sah tidak menulis tanggal invalid', () => {
  const now = Date.now();

  assert.equal(
    computeSlidingSessionExpiry({
      role: 'admin',
      now,
      tokenExpMs: Number.NaN,
      currentExpiresAt: new Date(now + HOUR),
    }),
    null,
  );
  assert.equal(
    computeSlidingSessionExpiry({
      role: 'admin',
      now,
      tokenExpMs: now + HOUR,
      currentExpiresAt: new Date('bukan-tanggal'),
    }),
    null,
  );
});

test('TTL staff dapat dikonfigurasi lewat environment', () => {
  withEnv(
    { ADMIN_SESSION_IDLE_MINUTES: '30', ADMIN_SESSION_ABSOLUTE_HOURS: '4' },
    () => {
      const policy = getSessionPolicy('admin');
      assert.equal(policy.idleMs, 30 * MINUTE);
      assert.equal(policy.absoluteExpiresIn, '4h');
    },
  );
});
