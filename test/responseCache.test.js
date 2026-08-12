const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const prisma = require('../src/lib/prisma');
const productCatalogRoutes = require('../src/routes/productCatalogRoutes');
const promoRoutes = require('../src/routes/promoRoutes');
const {
  setPrivateNoStoreHeaders,
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

test('source produksi tidak lagi memiliki cache Map per-instance', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '../src/lib/responseCache.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /new Map\s*\(/);
  assert.doesNotMatch(source, /createResponseCache/);
});
