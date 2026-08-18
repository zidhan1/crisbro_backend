const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const prisma = require('../src/lib/prisma');
const productCatalogRoutes = require('../src/routes/productCatalogRoutes');
const promoRoutes = require('../src/routes/promoRoutes');
const fs = require('node:fs');
const path = require('node:path');
const {
  setPrivateNoStoreHeaders,
  setPrivateResponseCacheHeaders,
  setSharedResponseCacheHeaders,
} = require('../src/lib/responseCache');

function mockResponse() {
  const headers = {};
  return {
    headers,
    response: {
      set(name, value) {
        headers[name] = value;
        return this;
      },
    },
  };
}

test('shared cache memakai CDN lintas instance dan browser wajib revalidate', () => {
  const { headers, response } = mockResponse();
  setSharedResponseCacheHeaders(response, 5 * 60 * 1000);
  assert.equal(
    headers['Cache-Control'],
    'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
  );
  assert.equal(headers['CDN-Cache-Control'], 'public, max-age=300');
  assert.equal(
    headers['Vercel-CDN-Cache-Control'],
    'public, max-age=300, stale-while-revalidate=60',
  );
});

test('semua endpoint default private/no-store', () => {
  const { headers, response } = mockResponse();
  let called = false;
  setPrivateNoStoreHeaders({}, response, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(headers.Pragma, 'no-cache');
});

test('endpoint katalog dan promo publik menimpa default dengan shared CDN cache', async (t) => {
  const originalMenuFindMany = prisma.menuItem.findMany;
  const originalPromoCount = prisma.promo.count;
  const originalPromoFindMany = prisma.promo.findMany;
  prisma.menuItem.findMany = async () => [];
  prisma.promo.count = async () => 0;
  prisma.promo.findMany = async () => [];

  const app = express();
  app.use(setPrivateNoStoreHeaders);
  app.use('/catalog/products', productCatalogRoutes);
  app.use('/promos', promoRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    prisma.menuItem.findMany = originalMenuFindMany;
    prisma.promo.count = originalPromoCount;
    prisma.promo.findMany = originalPromoFindMany;
    server.close();
  });

  const { port } = server.address();
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${port}/catalog/products?category_id=987654`),
    fetch(`http://127.0.0.1:${port}/promos?page=987654&limit=1`),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
    );
    assert.equal(response.headers.get('vercel-cdn-cache-control'),
      'public, max-age=300, stale-while-revalidate=60');
  }
});

test('route tanpa opt-in tidak mungkin menjadi public cache', async (t) => {
  const app = express();
  app.use(setPrivateNoStoreHeaders);
  app.get('/private-profile', (_req, res) =>
    res.json({ phone_number: '81234567890' }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/private-profile`);
  assert.equal(
    response.headers.get('cache-control'),
    'private, no-store, max-age=0',
  );
  assert.equal(response.headers.get('cdn-cache-control'), null);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), null);
});

// ---------------------------------------------------------------------------
// Endpoint di belakang autentikasi tidak boleh memakai shared cache: cookie
// sesi bukan bagian cache key di edge, sehingga respons untuk sesi yang sudah
// login berpotensi dilayani ke permintaan anonim pada path yang sama.
// ---------------------------------------------------------------------------

test('cache privat tidak pernah mengizinkan shared cache menyimpan respons', () => {
  const { headers, response } = mockResponse();
  setPrivateResponseCacheHeaders(response, 5 * 60 * 1000);

  assert.equal(headers['Cache-Control'], 'private, max-age=300');
  assert.doesNotMatch(headers['Cache-Control'], /(^|[ ,])public/);
  assert.doesNotMatch(headers['Cache-Control'], /s-maxage/);
  // Header khusus CDN lebih diprioritaskan edge daripada Cache-Control, jadi
  // keduanya harus ikut melarang, bukan sekadar dibiarkan kosong.
  assert.equal(headers['CDN-Cache-Control'], 'private, no-store');
  assert.equal(headers['Vercel-CDN-Cache-Control'], 'private, no-store');
});

test('endpoint outlet laporan (butuh login) memakai cache privat, bukan CDN', async (t) => {
  const app = express();
  app.use(setPrivateNoStoreHeaders);
  app.get('/admin/customer-sales-transaction-reports/outlets', (_req, res) => {
    setPrivateResponseCacheHeaders(res, 5 * 60 * 1000);
    res.json(['Outlet A', 'Outlet B']);
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/admin/customer-sales-transaction-reports/outlets`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(response.headers.get('cdn-cache-control'), 'private, no-store');
  assert.equal(
    response.headers.get('vercel-cdn-cache-control'),
    'private, no-store',
  );
  // Pragma warisan default global akan membatalkan max-age privat di sebagian
  // cache, jadi harus sudah dilepas pada respons ini.
  assert.equal(response.headers.get('pragma'), null);
});

test('shared cache hanya boleh dipakai endpoint yang benar-benar publik', () => {
  // Daftar putih, bukan sekadar mencatat keadaan sekarang: menambah pemakaian
  // shared cache di endpoint baru harus jadi keputusan sadar, karena endpoint
  // di belakang `auth` tidak boleh masuk ke sini.
  const allowedPublicModules = [
    'src/routes/productCatalogRoutes.js',
    'src/routes/promoRoutes.js',
  ];

  // Menyisir src/ DAN api/ (entry serverless Vercel), bukan src/ saja, supaya
  // handler yang ditaruh di luar src/ tidak lolos dari pemeriksaan ini.
  const scannedRoots = ['src', 'api'];
  const offenders = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const relative = path
        .relative(path.join(__dirname, '..'), full)
        .split(path.sep)
        .join('/');
      if (relative === 'src/lib/responseCache.js') continue;
      const source = fs.readFileSync(full, 'utf8');
      if (
        source.includes('setSharedResponseCacheHeaders') &&
        !allowedPublicModules.includes(relative)
      ) {
        offenders.push(relative);
      }
    }
  }
  for (const root of scannedRoots) {
    walk(path.join(__dirname, '..', root));
  }

  assert.deepEqual(
    offenders,
    [],
    'shared cache dipakai di modul yang tidak ada dalam daftar putih publik; ' +
      'endpoint di belakang autentikasi harus memakai setPrivateResponseCacheHeaders',
  );

  // Daftar putihnya sendiri harus tetap nyata, supaya test ini tidak lulus
  // hanya karena nama file berubah.
  for (const relative of allowedPublicModules) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.match(
      source,
      /setSharedResponseCacheHeaders/,
      `${relative} terdaftar publik tetapi tidak lagi memakai shared cache`,
    );
    assert.doesNotMatch(
      source,
      /require\('\.\.\/middleware\/auth'\)/,
      `${relative} tidak boleh berada di belakang autentikasi`,
    );
  }
});
