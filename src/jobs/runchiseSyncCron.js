const cron = require('node-cron');
const {
  syncCustomers,
  syncCustomerPoints,
  syncProducts,
  syncCrisbroRedeemMenu,
  syncBrands,
  syncLocations,
  syncPromos,
} = require('../services/syncService');

const DEFAULT_CRON = '*/30 * * * *';
let started = false;
let running = false;

async function runRunchiseSyncJob() {
  if (running) {
    console.log('[runchise-sync] skipped because previous run is still active');
    return { skipped: true };
  }

  running = true;
  const locationId = process.env.RUNCHISE_SYNC_LOCATION_ID || 1;
  const brandId = Number(process.env.RUNCHISE_SYNC_BRAND_ID || 1);

  try {
    console.log('[runchise-sync] started');

    const results = {};

    results.locations = await syncLocations(brandId);
    results.brands = await syncBrands();
    results.products = await syncProducts(brandId);
    results.redeemMenu = await syncCrisbroRedeemMenu(brandId);
    results.customers = await syncCustomers(locationId);
    results.customerPoints = await syncCustomerPoints(locationId);
    results.promos = await syncPromos();

    console.log('[runchise-sync] finished', results);
    return results;
  } finally {
    running = false;
  }
}

function startRunchiseSyncCron() {
  if (started) return null;

  if (process.env.RUNCHISE_SYNC_CRON_ENABLED === 'false') {
    console.log('[runchise-sync] cron disabled');
    return null;
  }

  started = true;
  const schedule = process.env.RUNCHISE_SYNC_CRON || DEFAULT_CRON;

  if (process.env.RUNCHISE_SYNC_ON_START !== 'false') {
    runRunchiseSyncJob().catch((error) => {
      console.error('[runchise-sync] initial run failed:', error.message);
    });
  }

  return cron.schedule(schedule, () => {
    runRunchiseSyncJob().catch((error) => {
      console.error('[runchise-sync] scheduled run failed:', error.message);
    });
  });
}

module.exports = {
  startRunchiseSyncCron,
  runRunchiseSyncJob,
};
