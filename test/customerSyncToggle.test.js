const test = require('node:test');
const assert = require('node:assert/strict');

// Sinkronisasi customer dijeda sementara karena impor Runchise adalah
// penyumbang pertumbuhan database terbesar (membuat puluhan ribu baris
// Customer/User baru), sedangkan kapasitas database saat ini masih terbatas.
//
// Yang dijaga test ini:
//   1. Saklar aktif secara default agar deployment tidak melewatkan impor;
//      hanya nilai "false" yang mematikannya secara eksplisit.
//   2. Worker BENAR-BENAR tidak menyentuh database saat dijeda -- ini yang
//      penting, karena penyebab utama impor tetap jalan bukan cron, melainkan
//      dashboard yang memanggil worker tiap 5 detik.
//   3. Menjeda BUKAN membatalkan: status job dan cursor-nya tidak diubah,
//      supaya bisa dilanjutkan dari halaman terakhir nanti.

const {
  isCustomerSyncEnabled,
  customerSyncDisabledResult,
} = require('../src/lib/customerSyncToggle');

const ORIGINAL_ENV = process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED;

test.afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED;
  else process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = ORIGINAL_ENV;
});

test('saklar aktif secara default ketika env belum diisi', () => {
  delete process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED;
  assert.equal(isCustomerSyncEnabled(), true);
});

test('hanya string "false" persis yang mematikan sinkronisasi', () => {
  for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'on', '', ' true ']) {
    process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = value;
    assert.equal(isCustomerSyncEnabled(), true, `"${value}" seharusnya tetap menyalakan`);
  }

  for (const value of ['false']) {
    process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = value;
    assert.equal(
      isCustomerSyncEnabled(),
      false,
      `"${value}" seharusnya mematikan sinkronisasi`,
    );
  }
});

test('balasan dijeda membawa alasan yang bisa dibedakan dari status lain', () => {
  const result = customerSyncDisabledResult(null);
  assert.equal(result.status, 'disabled');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'customer_sync_disabled');
  // Statusnya tidak boleh tertukar dengan 'idle'/'already_running'/'running'
  // yang dipakai jalur normal worker.
  assert.notEqual(result.status, 'idle');
  assert.notEqual(result.status, 'already_running');
});

test('balasan dijeda tetap meneruskan job apa adanya (dijeda, bukan dibatalkan)', () => {
  const job = { id: 7, status: 'queued', current_location_index: 3, current_page: 12 };
  const result = customerSyncDisabledResult(job);

  assert.deepEqual(result.job, job);
  assert.equal(result.job.status, 'queued', 'status job tidak boleh diubah jadi cancelled/failed');
  assert.equal(result.job.current_location_index, 3, 'cursor outlet harus tetap utuh');
  assert.equal(result.job.current_page, 12, 'cursor halaman harus tetap utuh');
});

test('worker impor tidak menyentuh database sama sekali saat dijeda', async () => {
  process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'false';

  // Modul di-require ulang agar memakai nilai env terbaru.
  delete require.cache[require.resolve('../src/services/customerImportSyncService')];
  const pg = require('pg');
  const originalClient = pg.Client;
  let clientsCreated = 0;
  pg.Client = class {
    constructor() {
      clientsCreated += 1;
    }
    async connect() {
      throw new Error('Worker seharusnya tidak membuka koneksi database saat dijeda');
    }
    async query() {
      throw new Error('Worker seharusnya tidak menjalankan query saat dijeda');
    }
    async end() {}
  };

  try {
    const {
      processCustomerImportSyncJob,
      createCustomerImportSyncJob,
    } = require('../src/services/customerImportSyncService');

    const processed = await processCustomerImportSyncJob();
    assert.equal(processed.status, 'disabled');
    assert.equal(processed.reason, 'customer_sync_disabled');

    const created = await createCustomerImportSyncJob({ source: 'cron' });
    assert.equal(created.created, false, 'job baru tidak boleh dibuat saat dijeda');
    assert.equal(created.reason, 'customer_sync_disabled');
  } finally {
    pg.Client = originalClient;
    delete require.cache[require.resolve('../src/services/customerImportSyncService')];
  }

  // Nol koneksi: jalur "disabled" keluar sebelum createDatabaseClient()
  // dipanggil sama sekali.
  assert.equal(clientsCreated, 0, 'jalur dijeda tidak boleh membuat client database');
});

test('worker timestamp customer juga tidak menyentuh database saat dijeda', async () => {
  process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'false';

  delete require.cache[require.resolve('../src/services/customerTimestampSyncService')];
  const pg = require('pg');
  const originalClient = pg.Client;
  pg.Client = class {
    async connect() {
      throw new Error('Worker timestamp seharusnya tidak membuka koneksi saat dijeda');
    }
    async query() {
      throw new Error('Worker timestamp seharusnya tidak menjalankan query saat dijeda');
    }
    async end() {}
  };

  try {
    const {
      processCustomerTimestampSyncJob,
      createCustomerTimestampSyncJob,
    } = require('../src/services/customerTimestampSyncService');

    const processed = await processCustomerTimestampSyncJob();
    assert.equal(processed.status, 'disabled');

    const created = await createCustomerTimestampSyncJob();
    assert.equal(created.created, false);
    assert.equal(created.reason, 'customer_sync_disabled');
  } finally {
    pg.Client = originalClient;
    delete require.cache[require.resolve('../src/services/customerTimestampSyncService')];
  }
});

test('sinkronisasi kembali berjalan normal begitu saklar dinyalakan', async () => {
  process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'true';

  // Koneksi lock di-inject lewat seam `dependencies.createClient` milik
  // service, sama seperti test worker lainnya. Menambal pg.Client global saja
  // tidak cukup: createAdvisoryLockClient() sengaja fail-closed menuntut
  // DIRECT_URL (M-3), dan argumen connectionString itu dievaluasi SEBELUM
  // constructor palsu dipanggil. Di laptop test tetap hijau karena
  // @prisma/client memuat .env saat import, sedangkan checkout CI tidak punya
  // .env sama sekali -- persis beda perilaku yang membuat CI merah (M-12).
  delete require.cache[require.resolve('../src/services/customerImportSyncService')];

  let connected = false;
  let lockClientsCreated = 0;
  const createClient = () => {
    lockClientsCreated += 1;
    return {
      async connect() {
        connected = true;
      },
      async query() {
        // Advisory lock gagal diambil -> worker keluar lebih awal tanpa
        // menyentuh data. Cukup untuk membuktikan jalur normal dijalankan lagi.
        return { rows: [{ acquired: false }] };
      },
      async end() {},
    };
  };

  // Jaring pengaman: jalur ini tidak boleh membuka koneksi pg sendiri di luar
  // client yang di-inject. Kalau suatu saat ada yang menambahkannya, test
  // gagal dengan pesan jelas, bukan diam-diam mencoba konek ke database asli.
  const pg = require('pg');
  const originalClient = pg.Client;
  pg.Client = class {
    constructor() {
      throw new Error('Worker harus memakai client yang di-inject, bukan membuka koneksi pg sendiri');
    }
  };

  try {
    const { processCustomerImportSyncJob } = require('../src/services/customerImportSyncService');
    const result = await processCustomerImportSyncJob({}, { createClient });

    assert.equal(connected, true, 'saat menyala, worker harus benar-benar jalan lagi');
    assert.equal(lockClientsCreated, 1, 'worker cukup memakai satu koneksi advisory lock');
    assert.notEqual(result.status, 'disabled');
  } finally {
    pg.Client = originalClient;
    delete require.cache[require.resolve('../src/services/customerImportSyncService')];
  }
});
