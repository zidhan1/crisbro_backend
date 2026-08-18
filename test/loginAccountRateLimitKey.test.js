const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const http = require('node:http');
const prisma = require('../src/lib/prisma');
const { loginAccountKey, loginAccountLimiter } = require('../src/lib/rateLimit');
const { normalizePhone, phoneVariants } = require('../src/lib/phoneNumber');

// Kuota login per-akun hanya berarti bila kuncinya menunjuk akun yang sama
// dengan yang dicari login(). Sebelumnya kunci memakai req.body.phone_number
// mentah, sehingga satu akun bisa dipukul dari banyak format nomor dan setiap
// format mendapat jatah 20 percobaan sendiri.

const SAME_ACCOUNT_FORMATS = [
  '81234567890',
  '081234567890',
  '0812-3456-7890',
  '0812 3456 7890',
  '+62 812 3456 7890',
  '+6281234567890',
  '6281234567890',
  '(0812) 3456-7890',
  '  081234567890  ',
];

test('semua format satu nomor menghasilkan SATU kunci kuota yang sama', () => {
  const keys = new Set(
    SAME_ACCOUNT_FORMATS.map((phone_number) => loginAccountKey({ body: { phone_number } })),
  );

  assert.equal(
    keys.size,
    1,
    `format berbeda dari nomor yang sama harus berbagi kuota, dapat: ${[...keys].join(', ')}`,
  );
  assert.equal([...keys][0], '81234567890');
});

test('kunci kuota identik dengan identitas yang dipakai login mencari user', () => {
  // login(): normalizePhone(...) lalu findFirst({ phone_number: { in: phoneVariants(...) } }).
  // Kalau kunci limiter dan identitas pencarian berbeda, batas per-akun bocor.
  for (const phone_number of SAME_ACCOUNT_FORMATS) {
    const normalized = normalizePhone(phone_number);
    assert.equal(loginAccountKey({ body: { phone_number } }), normalized);
    assert.ok(
      phoneVariants(normalized).includes('0' + normalized),
      'varian yang dicari login harus berasal dari nomor ternormalisasi yang sama',
    );
  }
});

test('nomor berbeda tetap punya kuota sendiri-sendiri', () => {
  assert.notEqual(
    loginAccountKey({ body: { phone_number: '081234567890' } }),
    loginAccountKey({ body: { phone_number: '081234567891' } }),
  );
});

test('body tanpa nomor yang bisa dipakai jatuh ke satu ember bersama', () => {
  const cases = [
    undefined,
    {},
    { phone_number: undefined },
    { phone_number: null },
    { phone_number: '' },
    { phone_number: '   ' },
    { phone_number: 'abcd' },
    { phone_number: '-- --' },
    { phone_number: {} },
    { phone_number: [] },
  ];

  for (const body of cases) {
    assert.equal(
      loginAccountKey({ body }),
      'tanpa-nomor',
      `body ${JSON.stringify(body)} harus tetap punya kunci yang valid`,
    );
  }
});

test('kunci selalu string tak kosong dan cukup pendek untuk PRIMARY KEY btree', () => {
  // express.json({ limit: '100kb' }) berjalan SEBELUM limiter, dan kunci ini
  // menjadi PRIMARY KEY di "RateLimitCounter". Kunci 100kb ditolak PostgreSQL
  // ("index row requires N bytes, maximum size is 8191") sehingga /login
  // membalas 500 tanpa perlu autentikasi.
  const hostile = [
    '9'.repeat(100_000),
    '+62 ' + '1234567890 '.repeat(5_000),
    Array.from({ length: 5_000 }, (_, i) => String(i % 10)).join('-'),
  ];

  for (const phone_number of hostile) {
    const key = loginAccountKey({ body: { phone_number } });
    assert.equal(typeof key, 'string');
    assert.ok(key.length > 0, 'kunci tidak boleh kosong');
    assert.ok(
      key.length <= 24,
      `kunci harus dibatasi, dapat ${key.length} karakter`,
    );
  }
});

test('nomor Indonesia terpanjang yang sah tidak ikut terpotong', () => {
  // Nomor seluler Indonesia ternormalisasi (diawali 8) paling panjang ~12 digit.
  const longestReal = '8' + '1'.repeat(11);
  assert.equal(longestReal.length, 12);
  assert.equal(
    loginAccountKey({ body: { phone_number: `+62${longestReal}` } }),
    longestReal,
    'batas panjang tidak boleh menyentuh nomor yang sah',
  );
});

// Menguji loginAccountKey saja belum membuktikan limiter benar-benar MEMAKAINYA.
// Test ini menjalankan middleware limiter yang asli dan mengintip kunci yang
// sampai ke store, sehingga salah kabel pada `keyGenerator` tetap ketahuan.
test('limiter login asli menghitung semua format nomor pada satu kuota', async (t) => {
  const originalQueryRaw = prisma.$queryRaw;
  const buckets = new Map();

  // PrismaRateLimitStore memanggil $queryRaw sebagai tagged template dengan
  // storeKey sebagai nilai pertama.
  prisma.$queryRaw = async (_strings, storeKey) => {
    const hits = (buckets.get(storeKey) ?? 0) + 1;
    buckets.set(storeKey, hits);
    return [{ hits, expires_at: new Date(Date.now() + 60_000) }];
  };

  const app = express();
  app.use(express.json());
  app.post('/login', loginAccountLimiter, (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    prisma.$queryRaw = originalQueryRaw;
    server.close();
  });

  const { port } = server.address();
  for (const phone_number of SAME_ACCOUNT_FORMATS) {
    const response = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number, password: 'salah' }),
    });
    assert.equal(response.status, 200);
  }

  assert.deepEqual(
    [...buckets.keys()],
    ['login-account:81234567890'],
    `semua format harus jatuh ke satu kunci store, dapat: ${[...buckets.keys()].join(', ')}`,
  );
  assert.equal(
    buckets.get('login-account:81234567890'),
    SAME_ACCOUNT_FORMATS.length,
    'setiap percobaan harus mengurangi kuota akun yang sama',
  );
});
