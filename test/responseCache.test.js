const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const prisma = require('../src/lib/prisma');
const productCatalogRoutes = require('../src/routes/productCatalogRoutes');
const promoRoutes = require('../src/routes/promoRoutes');
const {
  createResponseCache,
  setSharedResponseCacheHeaders,
} = require('../src/lib/responseCache');

test('cache lokal menghapus entry least-recently-used saat batas tercapai', () => {
  const cache = createResponseCache(60_000, { maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);

  // A menjadi entry terbaru; B harus menjadi korban eviction berikutnya.
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('c'), 3);
});

test('entry kedaluwarsa dibuang dan TTL invalid memakai default aman', (t) => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  const cache = createResponseCache(10);
  cache.set('short', 'value');
  now += 11;
  assert.equal(cache.get('short'), null);

  const fallbackCache = createResponseCache(Number.NaN);
  fallbackCache.set('safe', 'value', Number.NaN);
  now += 5 * 60 * 1000 - 1;
  assert.equal(fallbackCache.get('safe'), 'value');
  now += 2;
  assert.equal(fallbackCache.get('safe'), null);
});

test('header HTTP mengaktifkan cache browser terbatas dan shared cache', () => {
  const headers = {};
  const res = {
    set(name, value) {
      headers[name] = value;
      return this;
    },
  };

  setSharedResponseCacheHeaders(res, 5 * 60 * 1000);

  assert.equal(
    headers['Cache-Control'],
    'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
  );
});

test('endpoint katalog dan promo mengirim header shared-cache pada respons sukses', async (t) => {
  const originalMenuFindMany = prisma.menuItem.findMany;
  const originalPromoCount = prisma.promo.count;
  const originalPromoFindMany = prisma.promo.findMany;
  prisma.menuItem.findMany = async () => [];
  prisma.promo.count = async () => 0;
  prisma.promo.findMany = async () => [];

  const app = express();
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
  const [catalogResponse, promoResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/catalog/products?category_id=987654`),
    fetch(`http://127.0.0.1:${port}/promos?page=987654&limit=1`),
  ]);

  for (const response of [catalogResponse, promoResponse]) {
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
    );
  }
});
