const { Client } = require('pg');
const {
  RUNCHISE_MAX_PAGES,
  assertPageWithinLimit,
  extractSalesTransactions,
  fetchSalesTransactionsPage,
} = require('./runchiseService');
const {
  buildSalesTransactionParams,
  syncSalesTransactionReportsPage,
} = require('./syncService');

const SALES_SYNC_WORKER_LOCK_ID = 750954837;
const configuredBudgetMs = Number(process.env.RUNCHISE_SALES_WORKER_BUDGET_MS);
const configuredMaxPages = Number(process.env.RUNCHISE_SALES_WORKER_MAX_PAGES);
const DEFAULT_WORKER_BUDGET_MS = Number.isFinite(configuredBudgetMs)
  ? Math.min(Math.max(configuredBudgetMs, 3_000), 25_000)
  : 8_000;
const DEFAULT_MAX_PAGES_PER_INVOCATION = Number.isInteger(configuredMaxPages)
  ? Math.min(Math.max(configuredMaxPages, 1), 20)
  : 5;

function createDatabaseClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

function serializeJob(row) {
  if (!row) return null;
  const locationIds = Array.isArray(row.location_ids) ? row.location_ids : [];
  return {
    ...row,
    location_ids: locationIds,
    locations_total: locationIds.length,
    locations_completed: Math.min(
      Number(row.current_location_index) || 0,
      locationIds.length,
    ),
  };
}

async function getSalesTransactionSyncJob({ createClient = createDatabaseClient } = {}) {
  const client = createClient();
  try {
    await client.connect();
    const result = await client.query(`
      SELECT * FROM "SalesTransactionSyncJob"
      ORDER BY
        CASE WHEN "status" IN ('queued', 'running') THEN 0 ELSE 1 END,
        "id" DESC
      LIMIT 1
    `);
    return serializeJob(result.rows[0]);
  } finally {
    await client.end().catch(() => {});
  }
}

async function createSalesTransactionSyncJob(
  {
    source = 'cron',
    locationId = null,
    startDate = null,
    endDate = null,
    status = null,
    paymentMethodIds = null,
  } = {},
  { createClient = createDatabaseClient } = {},
) {
  const client = createClient();
  try {
    await client.connect();
    const existing = await client.query(
      `SELECT * FROM "SalesTransactionSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    if (existing.rows[0]) {
      return { created: false, job: serializeJob(existing.rows[0]) };
    }

    let locationIds;
    const explicitLocationId = Number(locationId);
    if (Number.isInteger(explicitLocationId) && explicitLocationId > 0) {
      locationIds = [explicitLocationId];
    } else {
      const locations = await client.query(`
        SELECT DISTINCT "runchise_id"::integer AS runchise_id
        FROM "Location"
        WHERE "is_outlet" = TRUE
          AND "is_active" = TRUE
          AND "runchise_id" IS NOT NULL
        ORDER BY runchise_id
      `);
      locationIds = locations.rows
        .map((row) => Number(row.runchise_id))
        .filter((id) => Number.isInteger(id) && id > 0);
    }

    if (locationIds.length === 0) {
      throw new Error('Tidak ada outlet aktif dengan runchise_id untuk sync sales');
    }

    const filters = {
      ...(status ? { status } : {}),
      ...(paymentMethodIds ? { payment_method_ids: paymentMethodIds } : {}),
    };
    const inserted = await client.query(
      `INSERT INTO "SalesTransactionSyncJob" (
        "status", "source", "location_ids", "current_location",
        "start_date", "end_date", "filters"
      ) VALUES ('queued', $1, $2::jsonb, $3, $4, $5, $6::jsonb)
      RETURNING *`,
      [
        source,
        JSON.stringify(locationIds),
        locationIds[0],
        startDate || null,
        endDate || null,
        JSON.stringify(filters),
      ],
    );
    return { created: true, job: serializeJob(inserted.rows[0]) };
  } finally {
    await client.end().catch(() => {});
  }
}

function pageHasMore(data, rows, page) {
  if (data?.paging?.next_page !== undefined) {
    return data.paging.next_page !== null;
  }
  if (data?.paging?.total_item !== undefined) {
    return page * Math.max(rows.length, 100) < Number(data.paging.total_item);
  }
  return rows.length >= 100;
}

async function processSalesPage(client, job, dependencies = {}) {
  const fetchPage = dependencies.fetchPage || fetchSalesTransactionsPage;
  const syncPage = dependencies.syncPage || syncSalesTransactionReportsPage;
  const locationIds = Array.isArray(job.location_ids) ? job.location_ids : [];
  const locationIndex = Number(job.current_location_index) || 0;
  if (locationIndex >= locationIds.length) {
    return { completed: true, job: serializeJob(job) };
  }

  const locationId = Number(locationIds[locationIndex]);
  const page = Number(job.current_page) || 1;
  assertPageWithinLimit('sales transaction worker', page, RUNCHISE_MAX_PAGES);
  const filters = job.filters && typeof job.filters === 'object' ? job.filters : {};
  const params = buildSalesTransactionParams({
    locationId,
    startDate: job.start_date,
    endDate: job.end_date,
    status: filters.status,
    paymentMethodIds: filters.payment_method_ids,
  });
  // Satu call worker tidak memakai retry internal. Error mengembalikan job ke
  // queued dan invocation cron berikutnya mengulang halaman yang sama.
  const data = await fetchPage(page, params, { retries: 0 });
  const sales = extractSalesTransactions(data);
  const result = await syncPage(locationId, sales);
  const hasMore = pageHasMore(data, sales, page);
  const nextLocationIndex = hasMore ? locationIndex : locationIndex + 1;
  const completed = nextLocationIndex >= locationIds.length;
  const nextLocation = completed ? null : Number(locationIds[nextLocationIndex]);
  const nextPage = hasMore ? page + 1 : 1;
  const status = completed ? 'completed' : 'running';

  const updated = await client.query(
    `UPDATE "SalesTransactionSyncJob"
     SET "status" = $2,
         "current_location_index" = $3,
         "current_location" = $4,
         "current_page" = $5,
         "pages_processed" = "pages_processed" + 1,
         "processed" = "processed" + $6,
         "synced" = "synced" + $7,
         "skipped" = "skipped" + $8,
         "heartbeat_at" = NOW(),
         "last_success_at" = NOW(),
         "finished_at" = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
         "error" = NULL
     WHERE "id" = $1
     RETURNING *`,
    [
      job.id,
      status,
      nextLocationIndex,
      nextLocation,
      nextPage,
      Number(result.processed) || 0,
      Number(result.synced) || 0,
      Number(result.skipped) || 0,
    ],
  );
  return { completed, job: serializeJob(updated.rows[0]) };
}

async function processSalesTransactionSyncJob(
  {
    timeBudgetMs = DEFAULT_WORKER_BUDGET_MS,
    maxPages = DEFAULT_MAX_PAGES_PER_INVOCATION,
  } = {},
  dependencies = {},
) {
  const createClient = dependencies.createClient || createDatabaseClient;
  const now = dependencies.now || Date.now;
  const client = createClient();
  let lockAcquired = false;
  let activeJobId = null;
  try {
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      SALES_SYNC_WORKER_LOCK_ID,
    ]);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) return { status: 'already_running', job: null };

    const active = await client.query(
      `SELECT * FROM "SalesTransactionSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    let job = active.rows[0];
    if (!job) {
      const latest = await client.query(
        `SELECT * FROM "SalesTransactionSyncJob" ORDER BY "id" DESC LIMIT 1`,
      );
      return { status: 'idle', job: serializeJob(latest.rows[0]) };
    }
    activeJobId = job.id;
    const running = await client.query(
      `UPDATE "SalesTransactionSyncJob"
       SET "status" = 'running', "heartbeat_at" = NOW(), "error" = NULL
       WHERE "id" = $1 RETURNING *`,
      [job.id],
    );
    job = running.rows[0];

    const budget = Math.min(
      Math.max(Number(timeBudgetMs) || DEFAULT_WORKER_BUDGET_MS, 1_000),
      25_000,
    );
    const deadline = now() + budget;
    const safeMaxPages = Math.min(Math.max(Number(maxPages) || 1, 1), 20);
    let pagesProcessed = 0;
    let serialized = serializeJob(job);

    while (pagesProcessed < safeMaxPages && now() < deadline) {
      const pageResult = await processSalesPage(client, job, dependencies);
      pagesProcessed++;
      serialized = pageResult.job;
      if (pageResult.completed) {
        return { status: serialized.status, job: serialized };
      }
      job = { ...job, ...pageResult.job };
    }
    return { status: 'running', job: serialized };
  } catch (error) {
    const message = String(error.message || error).slice(0, 4000);
    if (activeJobId !== null) {
      await client
        .query(
          `UPDATE "SalesTransactionSyncJob"
           SET "status" = 'queued', "failed" = "failed" + 1,
               "error" = $1, "heartbeat_at" = NOW()
           WHERE "id" = $2`,
          [message, activeJobId],
        )
        .catch(() => {});
    }
    throw error;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [SALES_SYNC_WORKER_LOCK_ID])
        .catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

module.exports = {
  SALES_SYNC_WORKER_LOCK_ID,
  createSalesTransactionSyncJob,
  getSalesTransactionSyncJob,
  processSalesTransactionSyncJob,
  processSalesPage,
  pageHasMore,
};
