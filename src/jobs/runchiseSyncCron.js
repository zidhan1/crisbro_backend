const cron = require('node-cron');
const {
  syncCustomers,
  syncCustomerPointsFromStaging,
  syncProducts,
  syncBrands,
  syncLocations,
  syncPromos,
} = require('../services/syncService');
const {
  createCustomerImportSyncJob,
  processCustomerImportSyncJob,
} = require('../services/customerImportSyncService');
const {
  isCustomerSyncEnabled,
  customerSyncDisabledResult,
} = require('../lib/customerSyncToggle');
const {
  createSalesTransactionSyncJob,
  processSalesTransactionSyncJob,
} = require('../services/salesTransactionSyncService');
const {
  RUNCHISE_CRON_LOCK_IDS,
  withDistributedCronLock,
} = require('../lib/distributedCronLock');
const {
  createSyncJobTelemetry,
  memorySnapshot,
} = require('../services/syncJobTelemetryService');

// C-1: Memecah master sync menjadi job terpisah dengan cron, mutex, checkpoint, dan worker berbasis cursor agar setiap tahap berjalan independen serta mencegah timeout Vercel menghentikan seluruh proses sinkronisasi.
const DEFAULT_LOCATIONS_CRON = '0 12 * * *';
const DEFAULT_BRANDS_CRON = '5 12 * * *';
const DEFAULT_PRODUCTS_CRON = '10 12 * * *';
const DEFAULT_CUSTOMERS_IMPORT_CRON = '15 12 * * *';
const DEFAULT_CUSTOMERS_IMPORT_WORKER_CRON = '*/10 * * * *';
const DEFAULT_SALES_CRON = '20 12 * * *';
const DEFAULT_PROMOS_CRON = '25 12 * * *';
const DEFAULT_POINTS_CRON = '30 12 * * *';

let started = false;

async function runLockedJob(name, lockId, job) {
  const telemetry = createSyncJobTelemetry();
  const telemetryId = await telemetry.enqueue(name).catch((error) => {
    // Telemetry bersifat observability dan tidak boleh menghentikan pekerjaan
    // bisnis bila migration/storage monitoring sedang bermasalah.
    console.error(`[runchise-sync:${name}] telemetry enqueue failed:`, error.message);
    return null;
  });
  const startedAt = Date.now();
  const initialMemory = memorySnapshot();

  try {
    const result = await withDistributedCronLock({
      jobName: `runchise-sync:${name}`,
      lockId,
      run: async () => {
        await telemetry.markRunning(telemetryId).catch((error) => {
          console.error(`[runchise-sync:${name}] telemetry start failed:`, error.message);
        });
        console.log(`[runchise-sync:${name}] started`);
        const jobResult = await job();
        console.log(`[runchise-sync:${name}] finished`, jobResult);
        return jobResult;
      },
    });

    if (result?.skipped) {
      console.log(`[runchise-sync:${name}] skipped`, result);
    }
    const finalMemory = memorySnapshot();
    await telemetry
      .finish(telemetryId, {
        result,
        durationMs: Date.now() - startedAt,
        memory: {
          rss: Math.max(initialMemory?.rss ?? 0, finalMemory?.rss ?? 0),
          heapUsed: Math.max(
            initialMemory?.heapUsed ?? 0,
            finalMemory?.heapUsed ?? 0,
          ),
        },
        lockSkipped: ['local_lock_busy', 'distributed_lock_busy'].includes(
          result?.reason,
        ),
      })
      .catch((error) => {
        console.error(`[runchise-sync:${name}] telemetry finish failed:`, error.message);
      });
    return result;
  } catch (error) {
    const finalMemory = memorySnapshot();
    await telemetry
      .fail(telemetryId, {
        error,
        durationMs: Date.now() - startedAt,
        memory: {
          rss: Math.max(initialMemory?.rss ?? 0, finalMemory?.rss ?? 0),
          heapUsed: Math.max(
            initialMemory?.heapUsed ?? 0,
            finalMemory?.heapUsed ?? 0,
          ),
        },
      })
      .catch((telemetryError) => {
        console.error(
          `[runchise-sync:${name}] telemetry failure recording failed:`,
          telemetryError.message,
        );
      });
    throw error;
  }
}

function getSyncConfig() {
  const rawLocationId = Number(process.env.RUNCHISE_SYNC_LOCATION_ID);

  return {
    // Menghapus fallback ID numerik agar sinkronisasi selalu menggunakan outlet ID yang valid dan tidak salah mengarah ke lokasi brand lain.
    locationId:
      Number.isInteger(rawLocationId) && rawLocationId > 0
        ? rawLocationId
        : null,
    brandId: Number(process.env.RUNCHISE_SYNC_BRAND_ID || 1),
  };
}

async function runSyncLocationsJob() {
  const { brandId } = getSyncConfig();
  return runLockedJob('locations', RUNCHISE_CRON_LOCK_IDS.locations, () =>
    syncLocations(brandId),
  );
}

async function runSyncBrandsJob() {
  return runLockedJob('brands', RUNCHISE_CRON_LOCK_IDS.brands, syncBrands);
}

async function runSyncProductsJob() {
  return runLockedJob('products', RUNCHISE_CRON_LOCK_IDS.products, syncProducts);
}

async function runSyncSalesTransactionReportsJob() {
  return runLockedJob('sales', RUNCHISE_CRON_LOCK_IDS.sales, async () => {
    // Cron hanya membuat/mengambil job persisten lalu mengerjakan beberapa
    // halaman sampai time budget. Invocation berikutnya melanjutkan cursor.
    // Job cron memakai jendela tujuh hari WIB agar koreksi transaksi terlambat
    // ikut tersapu tanpa memulai full-history scan pada setiap hari.
    const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const endDate = nowWib.toISOString().slice(0, 10);
    nowWib.setUTCDate(nowWib.getUTCDate() - 6);
    const startDate = nowWib.toISOString().slice(0, 10);
    const creation = await createSalesTransactionSyncJob({
      source: 'cron',
      startDate,
      endDate,
    });
    const result = await processSalesTransactionSyncJob();
    return { created: creation.created, ...result };
  });
}

// Dipanggil lebih sering daripada enqueue harian. Worker tidak membuat job
// baru saat idle sehingga tidak mengulang jendela yang sama terus-menerus.
async function runSalesTransactionWorkerJob() {
  return runLockedJob('sales', RUNCHISE_CRON_LOCK_IDS.sales, () =>
    processSalesTransactionSyncJob(),
  );
}

async function runSyncPromosJob() {
  return runLockedJob('promos', RUNCHISE_CRON_LOCK_IDS.promos, syncPromos);
}

// Impor customer penuh hanya untuk eksekusi manual/CLI, bukan cron, guna menghindari risiko timeout pada lingkungan serverless.
async function runCustomerSyncJob() {
  const { locationId } = getSyncConfig();
  return runLockedJob(
    'customers-full',
    RUNCHISE_CRON_LOCK_IDS.customersFull,
    () => syncCustomers(locationId),
  );
}

// Enqueue harian hanya membuat satu job bila tidak ada job aktif. Pemrosesan
// dipisahkan agar cron worker yang sering tidak pernah memulai full import baru
// saat antrean sedang idle.
async function runCustomerImportEnqueueJob() {
  if (!isCustomerSyncEnabled()) return customerSyncDisabledResult();

  return runLockedJob(
    'customers-import-enqueue',
    RUNCHISE_CRON_LOCK_IDS.customersImport,
    async () => {
      const result = await createCustomerImportSyncJob({ source: 'cron' });
      if (result.created) {
        console.log(
          '[runchise-sync:customers-import-enqueue] new job created',
          result.job?.id,
        );
      }
      return result;
    },
  );
}

// Worker berkala hanya melanjutkan job queued/running. Saat tidak ada job aktif
// hasilnya `idle`; worker tidak membuat job pengganti secara otomatis.
async function runCustomerImportWorkerJob() {
  if (!isCustomerSyncEnabled()) return customerSyncDisabledResult();

  return runLockedJob(
    'customers-import-worker',
    RUNCHISE_CRON_LOCK_IDS.customersImport,
    processCustomerImportSyncJob,
  );
}

async function runCustomerPointsSyncJob() {
  return runLockedJob('points', RUNCHISE_CRON_LOCK_IDS.points, async () => {
    // Sinkronisasi poin customer dijalankan dari tabel staging agar aman untuk cron serverless, sedangkan refresh penuh dari API dilakukan secara manual.
    const result = await syncCustomerPointsFromStaging();

    if (result.divergent_customers > 0) {
      console.warn(
        `[runchise-sync:points] ${result.divergent_customers} customer memiliki poin berbeda antar outlet; asumsi poin global per customer perlu ditinjau`,
      );
    }

    return result;
  });
}

// Scheduler lokal hanya aktif pada proses persisten/non-serverless, sedangkan production menggunakan Vercel Cron yang menjalankan setiap tahap sinkronisasi secara independen.
function startRunchiseSyncCron() {
  if (started) return null;

  if (process.env.RUNCHISE_SYNC_CRON_ENABLED === 'false') {
    console.log('[runchise-sync] cron disabled');
    return null;
  }

  started = true;

  const schedules = {
    locations:
      process.env.RUNCHISE_LOCATIONS_SYNC_CRON || DEFAULT_LOCATIONS_CRON,
    brands: process.env.RUNCHISE_BRANDS_SYNC_CRON || DEFAULT_BRANDS_CRON,
    products: process.env.RUNCHISE_PRODUCTS_SYNC_CRON || DEFAULT_PRODUCTS_CRON,
    customersImport:
      process.env.RUNCHISE_CUSTOMERS_IMPORT_SYNC_CRON ||
      DEFAULT_CUSTOMERS_IMPORT_CRON,
    customersImportWorker:
      process.env.RUNCHISE_CUSTOMERS_IMPORT_WORKER_SYNC_CRON ||
      DEFAULT_CUSTOMERS_IMPORT_WORKER_CRON,
    sales: process.env.RUNCHISE_SALES_SYNC_CRON || DEFAULT_SALES_CRON,
    promos: process.env.RUNCHISE_PROMOS_SYNC_CRON || DEFAULT_PROMOS_CRON,
    points: process.env.RUNCHISE_POINTS_SYNC_CRON || DEFAULT_POINTS_CRON,
  };

  const stageJobs = [
    ['locations', runSyncLocationsJob],
    ['brands', runSyncBrandsJob],
    ['products', runSyncProductsJob],
    ['customers-import-enqueue', runCustomerImportEnqueueJob],
    ['customers-import-worker', runCustomerImportWorkerJob],
    ['sales', runSyncSalesTransactionReportsJob],
    ['promos', runSyncPromosJob],
    ['points', runCustomerPointsSyncJob],
  ];

  if (process.env.RUNCHISE_SYNC_ON_START !== 'false') {
    // Setiap tahap dijalankan lepas (fire-and-forget) dan independen: satu
    // tahap gagal/timeout tidak menghalangi tahap lain berjalan.
    for (const [name, job] of stageJobs) {
      job().catch((error) => {
        console.error(
          `[runchise-sync:${name}] initial run failed:`,
          error.message,
        );
      });
    }
  }

  const tasks = {};
  tasks.locationsTask = cron.schedule(schedules.locations, () => {
    runSyncLocationsJob().catch((error) => {
      console.error(
        '[runchise-sync:locations] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.brandsTask = cron.schedule(schedules.brands, () => {
    runSyncBrandsJob().catch((error) => {
      console.error(
        '[runchise-sync:brands] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.productsTask = cron.schedule(schedules.products, () => {
    runSyncProductsJob().catch((error) => {
      console.error(
        '[runchise-sync:products] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.customersImportTask = cron.schedule(schedules.customersImport, () => {
    runCustomerImportEnqueueJob().catch((error) => {
      console.error(
        '[runchise-sync:customers-import-enqueue] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.customersImportWorkerTask = cron.schedule(
    schedules.customersImportWorker,
    () => {
      runCustomerImportWorkerJob().catch((error) => {
        console.error(
          '[runchise-sync:customers-import-worker] scheduled run failed:',
          error.message,
        );
      });
    },
  );
  tasks.salesTask = cron.schedule(schedules.sales, () => {
    runSyncSalesTransactionReportsJob().catch((error) => {
      console.error(
        '[runchise-sync:sales] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.promosTask = cron.schedule(schedules.promos, () => {
    runSyncPromosJob().catch((error) => {
      console.error(
        '[runchise-sync:promos] scheduled run failed:',
        error.message,
      );
    });
  });
  tasks.pointsTask = cron.schedule(schedules.points, () => {
    runCustomerPointsSyncJob().catch((error) => {
      console.error(
        '[runchise-sync:points] scheduled run failed:',
        error.message,
      );
    });
  });

  return tasks;
}

module.exports = {
  startRunchiseSyncCron,
  runSyncLocationsJob,
  runSyncBrandsJob,
  runSyncProductsJob,
  runSyncSalesTransactionReportsJob,
  runSalesTransactionWorkerJob,
  runSyncPromosJob,
  runCustomerSyncJob,
  runCustomerImportEnqueueJob,
  runCustomerImportWorkerJob,
  runCustomerPointsSyncJob,
};
