const cron = require('node-cron');
const {
  syncCustomers,
  syncCustomerPointsFromStaging,
  syncSalesTransactionReports,
  syncProducts,
  syncBrands,
  syncLocations,
  syncPromos,
} = require('../services/syncService');
const {
  createCustomerImportSyncJob,
  processCustomerImportSyncJob,
} = require('../services/customerImportSyncService');

// C-1: Memecah master sync menjadi job terpisah dengan cron, mutex, checkpoint, dan worker berbasis cursor agar setiap tahap berjalan independen serta mencegah timeout Vercel menghentikan seluruh proses sinkronisasi.
const DEFAULT_LOCATIONS_CRON = '0 12 * * *';
const DEFAULT_BRANDS_CRON = '5 12 * * *';
const DEFAULT_PRODUCTS_CRON = '10 12 * * *';
const DEFAULT_CUSTOMERS_IMPORT_CRON = '15,45 12 * * *';
const DEFAULT_SALES_CRON = '20 12 * * *';
const DEFAULT_PROMOS_CRON = '25 12 * * *';
const DEFAULT_POINTS_CRON = '30 12 * * *';

let started = false;
let locationsRunning = false;
let brandsRunning = false;
let productsRunning = false;
let customersRunning = false; // syncCustomers penuh: dipakai CLI/manual saja, tidak dijadwalkan.
let customerImportRunning = false; // worker berbasis cursor: ini yang dijadwalkan.
let salesRunning = false;
let promosRunning = false;
let pointsRunning = false;

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
  if (locationsRunning) {
    console.log(
      '[runchise-sync:locations] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  locationsRunning = true;
  const { brandId } = getSyncConfig();

  try {
    console.log('[runchise-sync:locations] started');
    const result = await syncLocations(brandId);
    console.log('[runchise-sync:locations] finished', result);
    return result;
  } finally {
    locationsRunning = false;
  }
}

async function runSyncBrandsJob() {
  if (brandsRunning) {
    console.log(
      '[runchise-sync:brands] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  brandsRunning = true;

  try {
    console.log('[runchise-sync:brands] started');
    const result = await syncBrands();
    console.log('[runchise-sync:brands] finished', result);
    return result;
  } finally {
    brandsRunning = false;
  }
}

async function runSyncProductsJob() {
  if (productsRunning) {
    console.log(
      '[runchise-sync:products] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  productsRunning = true;

  try {
    console.log('[runchise-sync:products] started');
    const result = await syncProducts();
    console.log('[runchise-sync:products] finished', result);
    return result;
  } finally {
    productsRunning = false;
  }
}

async function runSyncSalesTransactionReportsJob() {
  if (salesRunning) {
    console.log(
      '[runchise-sync:sales] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  salesRunning = true;
  const { locationId } = getSyncConfig();

  try {
    console.log('[runchise-sync:sales] started');
    const result = await syncSalesTransactionReports(locationId);
    console.log('[runchise-sync:sales] finished', result);
    return result;
  } finally {
    salesRunning = false;
  }
}

async function runSyncPromosJob() {
  if (promosRunning) {
    console.log(
      '[runchise-sync:promos] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  promosRunning = true;

  try {
    console.log('[runchise-sync:promos] started');
    const result = await syncPromos();
    console.log('[runchise-sync:promos] finished', result);
    return result;
  } finally {
    promosRunning = false;
  }
}

// Impor customer penuh hanya untuk eksekusi manual/CLI, bukan cron, guna menghindari risiko timeout pada lingkungan serverless.
async function runCustomerSyncJob() {
  if (customersRunning) {
    console.log(
      '[runchise-sync:customers-full] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  customersRunning = true;
  const { locationId } = getSyncConfig();

  try {
    console.log('[runchise-sync:customers-full] started');
    const result = await syncCustomers(locationId);
    console.log('[runchise-sync:customers-full] finished', result);
    return result;
  } finally {
    customersRunning = false;
  }
}

// Sinkronisasi customer terjadwal menggunakan worker berbasis cursor agar pemrosesan bertahap dapat dilanjutkan dari checkpoint terakhir tanpa berisiko timeout.
async function runCustomerImportWorkerJob() {
  if (customerImportRunning) {
    console.log(
      '[runchise-sync:customers-import] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  customerImportRunning = true;

  try {
    console.log('[runchise-sync:customers-import] started');

    const { created, job } = await createCustomerImportSyncJob({
      source: 'cron',
    });
    if (created) {
      console.log('[runchise-sync:customers-import] new job created', job?.id);
    }

    const result = await processCustomerImportSyncJob();
    console.log('[runchise-sync:customers-import] finished', result);
    return result;
  } finally {
    customerImportRunning = false;
  }
}

async function runCustomerPointsSyncJob() {
  if (pointsRunning) {
    console.log(
      '[runchise-sync:points] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  pointsRunning = true;

  try {
    console.log('[runchise-sync:points] started');

    // Sinkronisasi poin customer dijalankan dari tabel staging agar aman untuk cron serverless, sedangkan refresh penuh dari API dilakukan secara manual.
    const result = await syncCustomerPointsFromStaging();

    if (result.divergent_customers > 0) {
      console.warn(
        `[runchise-sync:points] ${result.divergent_customers} customer memiliki poin berbeda antar outlet; asumsi poin global per customer perlu ditinjau`,
      );
    }

    console.log('[runchise-sync:points] finished', result);
    return result;
  } finally {
    pointsRunning = false;
  }
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
    sales: process.env.RUNCHISE_SALES_SYNC_CRON || DEFAULT_SALES_CRON,
    promos: process.env.RUNCHISE_PROMOS_SYNC_CRON || DEFAULT_PROMOS_CRON,
    points: process.env.RUNCHISE_POINTS_SYNC_CRON || DEFAULT_POINTS_CRON,
  };

  const stageJobs = [
    ['locations', runSyncLocationsJob],
    ['brands', runSyncBrandsJob],
    ['products', runSyncProductsJob],
    ['customers-import', runCustomerImportWorkerJob],
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
    runCustomerImportWorkerJob().catch((error) => {
      console.error(
        '[runchise-sync:customers-import] scheduled run failed:',
        error.message,
      );
    });
  });
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
  runSyncPromosJob,
  runCustomerSyncJob,
  runCustomerImportWorkerJob,
  runCustomerPointsSyncJob,
};
