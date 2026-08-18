const test = require('node:test');
const assert = require('node:assert/strict');
// Menyalakan saklar sinkronisasi khusus untuk test ini: lihat penjelasan di
// test/enableCustomerSyncForTests.js. Harus sebelum service di-require.
require('./enableCustomerSyncForTests');

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
const {
  processImportPage,
  processCustomerImportSyncJob,
} = require('../src/services/customerImportSyncService');
const {
  processTimestampPage,
  processCustomerTimestampSyncJob,
} = require('../src/services/customerTimestampSyncService');
const { RUNCHISE_MAX_PAGES } = runchiseService;

// Kedua worker cron hanya berjalan bila saklar impor customer dinyalakan.
process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'true';

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

// ===================== WORKER CRON PRODUKSI (B-2 / sisa M-2) =====================
//
// Test di atas hanya menutup jalur manual/CLI (syncCustomers dkk). Dua worker
// berbasis cursor di bawah inilah yang benar-benar dijalankan cron produksi
// (customers-worker tiap 10 menit, customer-timestamps-worker), dan keduanya
// dulu memanggil fetchCustomersPage() TANPA assertPageWithinLimit().
//
// Bahayanya berbeda dari loop manual: satu invocation memang tidak pernah hang
// karena dibatasi maxPages + time budget. Yang rusak adalah cursor
// `current_page` yang bertahan LINTAS invocation -- job tidak akan pernah
// `completed`, dan cron menggempur API Runchise selamanya tanpa sinyal gagal.
// Karena itu yang dikunci di sini bukan cuma "ada error", tapi juga bahwa
// error-nya TERMINAL (status 'failed', bukan requeue 'queued').

const OVER_CAP_PAGE = RUNCHISE_MAX_PAGES + 1;

function createWorkerClientStub({ table, job }) {
  const recovery = [];
  const client = {
    recovery,
    async connect() {},
    async end() {},
    async query(sql, params) {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes(`SELECT * FROM "${table}"`)) return { rows: [job] };
      if (sql.includes(`SET "status" = 'running'`)) {
        return { rows: [{ ...job, status: 'running' }] };
      }
      // Satu-satunya UPDATE tersisa adalah jalur pemulihan di blok catch.
      if (sql.includes(`UPDATE "${table}"`)) {
        recovery.push({ sql, params });
        return { rows: [] };
      }
      throw new Error(`Query test tidak dikenali: ${sql}`);
    },
  };
  return client;
}

const importJob = {
  id: 77,
  status: 'queued',
  location_ids: [101, 202],
  current_location_index: 0,
  current_location: 101,
  current_page: OVER_CAP_PAGE,
  failed: 0,
};

const timestampJob = {
  id: 88,
  status: 'queued',
  location_ids: [101, 202],
  current_location_index: 0,
  current_location: 101,
  current_page: OVER_CAP_PAGE,
};

test('processImportPage() menegakkan cap SEBELUM memanggil API Runchise', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      processImportPage({}, importJob, {
        fetchPage: async () => {
          fetchCalls++;
          return { customers: [], paging: { next_page: OVER_CAP_PAGE + 1 } };
        },
      }),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customer import worker');
      assert.equal(error.maxPages, RUNCHISE_MAX_PAGES);
      return true;
    },
  );
  // Inti perbaikannya: cron berhenti membebani API, bukan sekadar melapor gagal.
  assert.equal(fetchCalls, 0);
});

test('processTimestampPage() menegakkan cap SEBELUM memanggil API Runchise', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      processTimestampPage({}, timestampJob, {
        fetchPage: async () => {
          fetchCalls++;
          return { customers: [], paging: { next_page: OVER_CAP_PAGE + 1 } };
        },
      }),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customer timestamp worker');
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test('halaman tepat DI cap masih diproses worker impor (tidak off-by-one)', async () => {
  const fetched = [];
  const client = {
    async query() {
      return { rows: [{ ...importJob, current_page: 1 }] };
    },
  };
  const result = await processImportPage(
    client,
    { ...importJob, current_page: RUNCHISE_MAX_PAGES },
    {
      fetchPage: async (locationId, page) => {
        fetched.push(page);
        return { customers: [], paging: { next_page: null } };
      },
    },
  );

  assert.deepEqual(fetched, [RUNCHISE_MAX_PAGES]);
  assert.equal(result.completed, false);
});

test('worker impor menandai job FAILED (bukan requeue) saat cap terlampaui', async () => {
  const client = createWorkerClientStub({
    table: 'CustomerImportSyncJob',
    job: importJob,
  });

  await assert.rejects(
    () =>
      processCustomerImportSyncJob(
        {},
        {
          createClient: () => client,
          fetchPage: async () => {
            throw new Error('API tidak boleh dipanggil saat cap terlampaui');
          },
        },
      ),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      return true;
    },
  );

  assert.equal(client.recovery.length, 1);
  const [message, status, jobId] = client.recovery[0].params;
  // Terminal: requeue akan membuat invocation berikutnya mengulang halaman yang
  // sama dan gagal lagi, selamanya.
  assert.equal(status, 'failed');
  // Dibatasi ke job yang sedang dikerjakan, bukan semua baris 'running'.
  assert.equal(jobId, importJob.id);
  assert.equal(client.recovery[0].sql.includes('WHERE "id" = $3'), true);
  assert.match(message, /batas aman/);
});

test('worker timestamp menandai job FAILED (bukan requeue) saat cap terlampaui', async () => {
  const client = createWorkerClientStub({
    table: 'CustomerTimestampSyncJob',
    job: timestampJob,
  });

  await assert.rejects(
    () =>
      processCustomerTimestampSyncJob(
        {},
        {
          createClient: () => client,
          fetchPage: async () => {
            throw new Error('API tidak boleh dipanggil saat cap terlampaui');
          },
        },
      ),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      return true;
    },
  );

  assert.equal(client.recovery.length, 1);
  const [, status, jobId] = client.recovery[0].params;
  assert.equal(status, 'failed');
  assert.equal(jobId, timestampJob.id);
});

test('error sementara TETAP requeue ke queued agar cursor bisa dilanjutkan', async () => {
  // Penjaga regresi: perbaikan cap tidak boleh membuat SEMUA kegagalan terminal.
  // Gangguan jaringan harus tetap melanjutkan dari cursor tersimpan.
  const client = createWorkerClientStub({
    table: 'CustomerImportSyncJob',
    job: { ...importJob, current_page: 1 },
  });

  await assert.rejects(
    () =>
      processCustomerImportSyncJob(
        {},
        {
          createClient: () => client,
          fetchPage: async () => {
            const error = new Error('socket hang up');
            error.code = 'ECONNRESET';
            throw error;
          },
        },
      ),
    /socket hang up/,
  );

  assert.equal(client.recovery.length, 1);
  const [, status] = client.recovery[0].params;
  assert.equal(status, 'queued');
});

test('error sementara pada worker timestamp juga tetap requeue ke queued', async () => {
  const client = createWorkerClientStub({
    table: 'CustomerTimestampSyncJob',
    job: { ...timestampJob, current_page: 1 },
  });

  await assert.rejects(
    () =>
      processCustomerTimestampSyncJob(
        {},
        {
          createClient: () => client,
          fetchPage: async () => {
            throw new Error('upstream 503');
          },
        },
      ),
    /upstream 503/,
  );

  const [, status] = client.recovery[0].params;
  assert.equal(status, 'queued');
});
