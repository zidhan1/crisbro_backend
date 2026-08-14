const { createAdvisoryLockClient } = require('./advisoryLockClient');

// Namespace ini membedakan lock cron Runchise dari advisory lock aplikasi lain.
// PostgreSQL menerima pasangan signed int32 sehingga key tetap stabil lintas proses.
const RUNCHISE_CRON_LOCK_NAMESPACE = 1_384_405_203;

const RUNCHISE_CRON_LOCK_IDS = Object.freeze({
  locations: 1,
  brands: 2,
  products: 3,
  customersFull: 4,
  customersImport: 5,
  sales: 6,
  promos: 7,
  points: 8,
});

const locallyRunning = new Set();

/**
 * Menjalankan job maksimal satu kali secara global.
 *
 * Client khusus wajib dipertahankan sampai callback selesai karena PostgreSQL
 * session advisory lock melekat pada koneksi yang mengambilnya. Mutex lokal
 * hanya optimasi; advisory lock adalah guard utama antar-instance/serverless.
 */
async function withDistributedCronLock({
  jobName,
  lockId,
  run,
  createClient = createAdvisoryLockClient,
}) {
  if (locallyRunning.has(lockId)) {
    return {
      skipped: true,
      reason: 'local_lock_busy',
      job: jobName,
    };
  }

  locallyRunning.add(lockId);
  const client = createClient();
  let lockAcquired = false;

  try {
    await client.connect();

    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [RUNCHISE_CRON_LOCK_NAMESPACE, lockId],
    );
    lockAcquired = lock.rows[0]?.acquired === true;

    if (!lockAcquired) {
      return {
        skipped: true,
        reason: 'distributed_lock_busy',
        job: jobName,
      };
    }

    return await run();
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [
          RUNCHISE_CRON_LOCK_NAMESPACE,
          lockId,
        ])
        .catch((error) => {
          console.error(`[${jobName}] failed to release advisory lock:`, error.message);
        });
    }

    await client.end().catch((error) => {
      console.error(`[${jobName}] failed to close lock connection:`, error.message);
    });
    locallyRunning.delete(lockId);
  }
}

module.exports = {
  RUNCHISE_CRON_LOCK_NAMESPACE,
  RUNCHISE_CRON_LOCK_IDS,
  withDistributedCronLock,
};
