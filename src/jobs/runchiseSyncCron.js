const cron = require('node-cron');
const {
  syncCustomers,
  syncCustomerPoints,
  syncSalesTransactionReports,
  syncProductsAndRedeemMenu,
  syncBrands,
  syncLocations,
  syncPromos,
} = require('../services/syncService');

const DEFAULT_MASTER_CRON = '0 12,18 * * *';
const DEFAULT_POINTS_CRON = '*/30 * * * *';
let started = false;
let masterRunning = false;
let customersRunning = false;
let pointsRunning = false;

function getSyncConfig() {
  return {
    locationId: process.env.RUNCHISE_SYNC_LOCATION_ID || 1,
    brandId: Number(process.env.RUNCHISE_SYNC_BRAND_ID || 1),
  };
}

async function runRunchiseMasterSyncJob() {
  if (masterRunning) {
    console.log(
      '[runchise-sync:master] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  masterRunning = true;
  const { locationId, brandId } = getSyncConfig();

  try {
    console.log('[runchise-sync:master] started');

    const results = {};

    results.locations = await syncLocations(brandId);
    results.brands = await syncBrands();
    Object.assign(results, await syncProductsAndRedeemMenu(brandId));
    results.customers = await runCustomerSyncJob();
    results.salesTransactionReports =
      await syncSalesTransactionReports(locationId);
    results.promos = await syncPromos();

    console.log('[runchise-sync:master] finished', results);
    return results;
  } finally {
    masterRunning = false;
  }
}

async function runCustomerSyncJob() {
  if (customersRunning) {
    console.log(
      '[runchise-sync:customers] skipped because previous run is still active',
    );
    return { skipped: true };
  }

  customersRunning = true;
  const { locationId } = getSyncConfig();

  try {
    console.log('[runchise-sync:customers] started');
    const result = await syncCustomers(locationId);
    console.log('[runchise-sync:customers] finished', result);
    return result;
  } finally {
    customersRunning = false;
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
  const { locationId } = getSyncConfig();

  try {
    console.log('[runchise-sync:points] started');
    const result = await syncCustomerPoints(locationId);
    console.log('[runchise-sync:points] finished', result);
    return result;
  } finally {
    pointsRunning = false;
  }
}

function startRunchiseSyncCron() {
  if (started) return null;

  if (process.env.RUNCHISE_SYNC_CRON_ENABLED === 'false') {
    console.log('[runchise-sync] cron disabled');
    return null;
  }

  started = true;
  const masterSchedule =
    process.env.RUNCHISE_MASTER_SYNC_CRON ||
    process.env.RUNCHISE_SYNC_CRON ||
    DEFAULT_MASTER_CRON;
  const pointsSchedule =
    process.env.RUNCHISE_POINTS_SYNC_CRON || DEFAULT_POINTS_CRON;

  if (process.env.RUNCHISE_SYNC_ON_START !== 'false') {
    runRunchiseMasterSyncJob().catch((error) => {
      console.error(
        '[runchise-sync:master] initial run failed:',
        error.message,
      );
    });
    runCustomerPointsSyncJob().catch((error) => {
      console.error(
        '[runchise-sync:points] initial run failed:',
        error.message,
      );
    });
  }

  const masterTask = cron.schedule(masterSchedule, () => {
    runRunchiseMasterSyncJob().catch((error) => {
      console.error(
        '[runchise-sync:master] scheduled run failed:',
        error.message,
      );
    });
  });

  const pointsTask = cron.schedule(pointsSchedule, () => {
    runCustomerPointsSyncJob().catch((error) => {
      console.error(
        '[runchise-sync:points] scheduled run failed:',
        error.message,
      );
    });
  });

  return { masterTask, pointsTask };
}

module.exports = {
  startRunchiseSyncCron,
  runRunchiseSyncJob: runRunchiseMasterSyncJob,
  runRunchiseMasterSyncJob,
  runCustomerSyncJob,
  runCustomerPointsSyncJob,
};
