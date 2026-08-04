const { Client } = require('pg');
const { fetchCustomersPage } = require('./runchiseService');
const { upsertRunchiseCustomer } = require('./syncService');

// Lock terpisah dari worker timestamp agar keduanya boleh berjalan bersamaan.
const CUSTOMER_IMPORT_WORKER_LOCK_ID = 750954836;
// vercel.json tidak menyetel maxDuration, jadi function mati di ~10 detik.
// Budget dibuat lebih pendek supaya worker sempat menyimpan cursor sebelum
// dipotong; job yang terpotong tetap bisa dilanjutkan karena baris 'running'
// ikut terambil oleh worker berikutnya dan advisory lock lepas sendiri saat
// koneksi putus.
const DEFAULT_WORKER_BUDGET_MS = 8_000;
const DEFAULT_MAX_PAGES = 10;

function createDatabaseClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

function parseRunchiseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function serializeJob(row) {
  if (!row) return null;

  const locationIds = Array.isArray(row.location_ids) ? row.location_ids : [];

  return {
    ...row,
    location_ids: locationIds,
    locations_total: locationIds.length,
    locations_completed: Math.min(
      Number(row.current_location_index),
      locationIds.length,
    ),
  };
}

async function getCustomerImportSyncJob() {
  const client = createDatabaseClient();
  try {
    await client.connect();
    const result = await client.query(
      `
        SELECT * FROM "CustomerImportSyncJob"
        ORDER BY
          CASE WHEN "status" IN ('queued', 'running') THEN 0 ELSE 1 END,
          "id" DESC
        LIMIT 1
      `,
    );
    return serializeJob(result.rows[0]);
  } finally {
    await client.end().catch(() => {});
  }
}

async function createCustomerImportSyncJob({ source = 'dashboard' } = {}) {
  const client = createDatabaseClient();
  try {
    await client.connect();
    const existing = await client.query(
      `SELECT * FROM "CustomerImportSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    if (existing.rows[0]) {
      return { created: false, job: serializeJob(existing.rows[0]) };
    }

    const locationsResult = await client.query(
      `
        SELECT DISTINCT "runchise_id"::integer AS runchise_id
        FROM "Location"
        WHERE "is_outlet" = TRUE
          AND "is_active" = TRUE
          AND "runchise_id" IS NOT NULL
        ORDER BY runchise_id
      `,
    );
    const locationIds = locationsResult.rows
      .map((row) => Number(row.runchise_id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (locationIds.length === 0) {
      // Fallback ke ID 1 menunjuk outlet yang bukan milik Crisbar, sehingga job
      // akan selesai tanpa memproses satu customer pun.
      const fallback = Number(process.env.RUNCHISE_SYNC_LOCATION_ID);

      if (!Number.isInteger(fallback) || fallback <= 0) {
        throw new Error(
          'Tidak ada outlet aktif dengan runchise_id dan RUNCHISE_SYNC_LOCATION_ID belum diisi',
        );
      }

      locationIds.push(fallback);
    }

    const inserted = await client.query(
      `
        INSERT INTO "CustomerImportSyncJob" (
          "status", "source", "phase", "location_ids", "current_location"
        ) VALUES ('queued', $1, 'recent', $2::jsonb, $3)
        RETURNING *
      `,
      [source, JSON.stringify(locationIds), locationIds[0]],
    );

    return { created: true, job: serializeJob(inserted.rows[0]) };
  } finally {
    await client.end().catch(() => {});
  }
}

// Memproses satu halaman API (maksimal 100 customer) lalu memajukan cursor.
async function processImportPage(client, job) {
  const locationIds = Array.isArray(job.location_ids) ? job.location_ids : [];
  const locationIndex = Number(job.current_location_index);
  if (locationIndex >= locationIds.length) return { completed: true, job: serializeJob(job) };

  const locationId = Number(locationIds[locationIndex]);
  const page = Number(job.current_page) || 1;
  const data = await fetchCustomersPage(locationId, page);
  const customers = Array.isArray(data.customers) ? data.customers : [];

  let created = 0;
  let updated = 0;
  let skippedConflicts = 0;
  let failed = 0;
  let latestRunchiseCreatedAt = null;

  for (const customer of customers) {
    const runchiseCreatedAt = parseRunchiseTimestamp(customer.created_at);
    if (
      runchiseCreatedAt &&
      (!latestRunchiseCreatedAt || runchiseCreatedAt > latestRunchiseCreatedAt)
    ) {
      latestRunchiseCreatedAt = runchiseCreatedAt;
    }

    try {
      const result = await upsertRunchiseCustomer(customer, locationId);
      if (result.status === 'created') created++;
      else if (result.status === 'updated') updated++;
      else skippedConflicts++;
    } catch (error) {
      // Satu customer bermasalah tidak boleh menghentikan seluruh job; job
      // menyimpan cursor dan lanjut ke customer berikutnya.
      failed++;
      console.warn(
        `Impor customer Runchise gagal (location ${locationId}, customer ${customer?.id}): ${error.message}`,
      );
    }
  }

  const hasNextPage =
    data.paging?.next_page !== null && data.paging?.next_page !== undefined;
  const nextLocationIndex = hasNextPage ? locationIndex : locationIndex + 1;
  const nextPage = hasNextPage ? page + 1 : 1;
  const completed = nextLocationIndex >= locationIds.length;
  const nextLocation = completed ? null : Number(locationIds[nextLocationIndex]);
  const status = completed
    ? failed > 0 || Number(job.failed) > 0
      ? 'completed_with_errors'
      : 'completed'
    : 'running';

  const result = await client.query(
    `
      UPDATE "CustomerImportSyncJob"
      SET
        "status" = $2,
        "phase" = CASE WHEN $2 = 'running' THEN "phase" ELSE 'completed' END,
        "current_location_index" = $3,
        "current_location" = $4,
        "current_page" = $5,
        "total_api" = "total_api" + $6,
        "processed" = "processed" + $7,
        "created" = "created" + $8,
        "updated" = "updated" + $9,
        "skipped_conflicts" = "skipped_conflicts" + $10,
        "failed" = "failed" + $11,
        "latest_runchise_created_at" = GREATEST(
          "latest_runchise_created_at",
          $12::timestamp
        ),
        "latest_local_created_at" = (
          SELECT MAX("created_at") FROM "Customer"
        ),
        "heartbeat_at" = NOW(),
        "finished_at" = CASE WHEN $2 = 'running' THEN NULL ELSE NOW() END,
        "error" = NULL
      WHERE "id" = $1
      RETURNING *
    `,
    [
      job.id,
      status,
      nextLocationIndex,
      nextLocation,
      nextPage,
      page === 1 ? Number(data.paging?.total_item ?? customers.length) : 0,
      customers.length,
      created,
      updated,
      skippedConflicts,
      failed,
      latestRunchiseCreatedAt,
    ],
  );

  return { completed, job: serializeJob(result.rows[0]) };
}

async function processCustomerImportSyncJob({
  timeBudgetMs = DEFAULT_WORKER_BUDGET_MS,
  maxPages = DEFAULT_MAX_PAGES,
} = {}) {
  const client = createDatabaseClient();
  let lockAcquired = false;
  try {
    await client.connect();
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [CUSTOMER_IMPORT_WORKER_LOCK_ID],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      const running = await client.query(
        `SELECT * FROM "CustomerImportSyncJob"
         WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
      );
      return { status: 'already_running', job: serializeJob(running.rows[0]) };
    }

    const active = await client.query(
      `SELECT * FROM "CustomerImportSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    let job = active.rows[0];
    if (!job) {
      const latest = await client.query(
        `SELECT * FROM "CustomerImportSyncJob" ORDER BY "id" DESC LIMIT 1`,
      );
      return { status: 'idle', job: serializeJob(latest.rows[0]) };
    }

    await client.query(
      `UPDATE "CustomerImportSyncJob"
       SET "status" = 'running', "heartbeat_at" = NOW(), "error" = NULL
       WHERE "id" = $1`,
      [job.id],
    );

    const deadline =
      Date.now() +
      Math.min(
        Math.max(Number(timeBudgetMs) || DEFAULT_WORKER_BUDGET_MS, 3_000),
        25_000,
      );
    const safeMaxPages = Math.min(Math.max(Number(maxPages) || 1, 1), 20);
    let pagesProcessed = 0;
    let serialized = serializeJob(job);

    do {
      const result = await processImportPage(client, job);
      pagesProcessed++;
      serialized = result.job;
      if (result.completed) {
        return { status: serialized.status, job: serialized };
      }
      job = { ...job, ...result.job };
    } while (pagesProcessed < safeMaxPages && Date.now() < deadline);

    return { status: 'running', job: serialized };
  } catch (error) {
    const message = String(error.message || error).slice(0, 4000);
    // Dikembalikan ke 'queued' agar percobaan berikutnya melanjutkan dari
    // cursor tersimpan, bukan mengulang job dari awal.
    await client
      .query(
        `UPDATE "CustomerImportSyncJob"
         SET "status" = 'queued', "error" = $1, "heartbeat_at" = NOW()
         WHERE "status" = 'running'`,
        [message],
      )
      .catch(() => {});
    throw error;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [CUSTOMER_IMPORT_WORKER_LOCK_ID])
        .catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

module.exports = {
  createCustomerImportSyncJob,
  getCustomerImportSyncJob,
  processCustomerImportSyncJob,
};
