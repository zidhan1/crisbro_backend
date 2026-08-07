const test = require('node:test');
const assert = require('node:assert/strict');

// M-2: syncCustomers(), syncCustomerPoints(), dan
// fetchRunchiseCustomerLookupForLocation() memanggil fetchCustomersPage()
// langsung dalam loop while(hasMore) tanpa hard-cap halaman — berbeda dari
// fetchAllCustomers() dkk di runchiseService.js yang sudah dijaga
// assertPageWithinLimit(). Kalau Runchise API mengembalikan paging.next_page
// yang TIDAK PERNAH null (bug upstream, response cacat, atau kesalahan
// integrasi), ketiga loop itu akan berjalan selamanya sampai function
// serverless dibunuh oleh timeout, bukan gagal cepat dan bersih.
//
// Test ini menyimulasikan upstream yang selalu mengembalikan next_page,
// dengan RUNCHISE_API_MAX_PAGES dikecilkan supaya cepat, dan membuktikan
// ketiga fungsi berhenti dengan error RUNCHISE_MAX_PAGES_EXCEEDED setelah
// jumlah panggilan yang terbatas — bukan infinite loop.

process.env.RUNCHISE_API_MAX_PAGES = '3';

const runchiseService = require('../src/services/runchiseService');
const prisma = require('../src/lib/prisma');

// syncService.js men-destructure fetchCustomersPage sekali saat require —
// reassign runchiseService.fetchCustomersPage SETELAH itu tidak akan
// terlihat oleh syncService.js. Karena itu dipasang satu wrapper stabil di
// sini, lalu tiap test cukup mengganti `currentFetchCustomersPageImpl` yang
// dirujuk ulang setiap panggilan.
function alwaysHasNextPageImpl(locationId, page) {
  // customers sengaja kosong: yang diuji adalah loop paginasinya, bukan
  // proses upsert-nya, jadi tidak boleh menyentuh DB sungguhan.
  return Promise.resolve({ customers: [], paging: { next_page: page + 1 } });
}

let fetchCustomersPageCalls;
let currentFetchCustomersPageImpl = alwaysHasNextPageImpl;
runchiseService.fetchCustomersPage = async (locationId, page) => {
  fetchCustomersPageCalls.push({ locationId, page });
  return currentFetchCustomersPageImpl(locationId, page);
};
runchiseService.fetchAllLocations = async () => [{ id: 101 }];

const originalCustomerFindMany = prisma.customer.findMany;
prisma.customer.findMany = async () => [];

const {
  syncCustomers,
  syncCustomerPoints,
  fetchRunchiseCustomerLookupForLocation,
} = require('../src/services/syncService');
const { RUNCHISE_MAX_PAGES } = runchiseService;

test.beforeEach(() => {
  fetchCustomersPageCalls = [];
  currentFetchCustomersPageImpl = alwaysHasNextPageImpl;
});

test.after(() => {
  prisma.customer.findMany = originalCustomerFindMany;
});

test('RUNCHISE_API_MAX_PAGES dikecilkan sesuai override env untuk test ini', () => {
  assert.equal(RUNCHISE_MAX_PAGES, 3);
});

test('syncCustomers() berhenti dengan error terukur, bukan infinite loop, saat next_page tak pernah null', async () => {
  await assert.rejects(
    () => syncCustomers(),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customers');
      assert.equal(error.maxPages, RUNCHISE_MAX_PAGES);
      return true;
    },
  );
  // Berhenti tepat setelah percobaan halaman ke maxPages+1, bukan lanjut terus.
  assert.equal(fetchCustomersPageCalls.length, RUNCHISE_MAX_PAGES);
  assert.deepEqual(
    fetchCustomersPageCalls.map((c) => c.page),
    [1, 2, 3],
  );
});

test('syncCustomerPoints() berhenti dengan error terukur, bukan infinite loop, saat next_page tak pernah null', async () => {
  await assert.rejects(
    () => syncCustomerPoints({ locationId: 202 }),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customers');
      return true;
    },
  );
  assert.equal(fetchCustomersPageCalls.length, RUNCHISE_MAX_PAGES);
});

test('fetchRunchiseCustomerLookupForLocation() berhenti dengan error terukur, bukan infinite loop', async () => {
  await assert.rejects(
    () => fetchRunchiseCustomerLookupForLocation(303),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customers');
      return true;
    },
  );
  assert.equal(fetchCustomersPageCalls.length, RUNCHISE_MAX_PAGES);
});

test('halaman terakhir yang valid (=maxPages) tetap diproses normal, cap tidak off-by-one', async () => {
  // next_page berhenti null tepat SEBELUM cap terlampaui -> tidak boleh error.
  currentFetchCustomersPageImpl = async (locationId, page) => {
    const hasNext = page < RUNCHISE_MAX_PAGES;
    return { customers: [], paging: { next_page: hasNext ? page + 1 : null } };
  };

  const lookup = await fetchRunchiseCustomerLookupForLocation(404);
  assert.equal(lookup.size, 0);
  assert.equal(fetchCustomersPageCalls.length, RUNCHISE_MAX_PAGES);
});
