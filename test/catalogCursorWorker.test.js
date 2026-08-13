const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { processKindPage, PAGE_CAPS } = require('../src/services/catalogSyncJobService');

test('C-1: empat catalog stage punya cap realistis, jauh di bawah 10.000', () => {
  assert.deepEqual(PAGE_CAPS, { products: 500, promos: 200, brands: 500, locations: 200 });
});

test('C-1: product worker memproses tepat satu halaman dan mematikan retry internal', async () => {
  let options;
  let written = 0;
  const context = { categoryIds: new Set([10]), categoryNames: new Map([[10, 'Food']]), brandId: 1 };
  const result = await processKindPage('products', 7, new Set(), {
    fetchProductsPage: async (params, requestOptions) => {
      assert.equal(params.page, 7);
      options = requestOptions;
      return {
        products: [{ id: 77, name: 'Produk', sell_price: 1000, status: 'activated', product_category: { id: 10 } }],
        paging: { next_page: 8, total_item: 1000 },
      };
    },
    loadProductContext: async () => context,
    upsertProductChunk: async (_db, rows) => { written += rows.length; },
  });
  assert.deepEqual(options, { retries: 0 });
  assert.equal(result.items.length, 1);
  assert.equal(written, 1);
});

test('C-1: endpoint dan Vercel memiliki catalog worker berkala terpisah', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.match(indexSource, /runchise-sync\/catalog-worker/);
  assert.ok(vercel.crons.some((cron) => cron.path.endsWith('/catalog-worker') && cron.schedule.includes('*/5')));
});

test('C-1: catalog worker memakai deadline admission guard dan cursor persisten', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'catalogSyncJobService.js'), 'utf8');
  assert.match(source, /hasTimeForNextRequest\(deadline,RUNCHISE_REQUEST_TIMEOUT_MS\)/);
  assert.match(source, /"current_page"=\$3/);
  assert.match(source, /\{ retries: 0 \}/);
});
