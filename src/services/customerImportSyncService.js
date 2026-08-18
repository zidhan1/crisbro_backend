const { Client } = require('pg');
const {
  fetchCustomersPage,
  assertPageWithinLimit,
  RUNCHISE_MAX_PAGES,
  RUNCHISE_REQUEST_TIMEOUT_MS,
} = require('./runchiseService');
const {
  upsertRunchiseCustomersBatch,
} = require('./syncService');
const {
  isCustomerSyncEnabled,
  customerSyncDisabledResult,
} = require('../lib/customerSyncToggle');
const {
  MAX_WORKER_BUDGET_MS,
  clampWorkerBudgetMs,
  hasTimeForNextRequest,
} = require('../lib/serverlessBudget');
const { createAdvisoryLockClient } = require('../lib/advisoryLockClient');

// Lock terpisah dari worker timestamp agar keduanya boleh berjalan bersamaan.
const CUSTOMER_IMPORT_WORKER_LOCK_ID = 750954836;
// Runtime Vercel adalah 30 detik. Helper serverlessBudget menyisakan 10 detik
// untuk checkpoint, unlock, penutupan koneksi, dan pengiriman response.
// Default lama 8 detik membuat maxPages praktis tidak terpakai karena timeout
// satu request Runchise sendiri dapat mencapai 6 detik.
const DEFAULT_WORKER_BUDGET_MS = MAX_WORKER_BUDGET_MS;
// Batas keselamatan tinggi; time budget tetap menjadi pembatas utama sehingga
// worker tidak akan memulai request baru ketika reserve serverless terpakai.
const DEFAULT_MAX_PAGES = 20;

function getCustomerImportWorkerConfig(overrides = {}) {
  const requestedBudget =
    overrides.timeBudgetMs ??
    process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS ??
    DEFAULT_WORKER_BUDGET_MS;
  const requestedMaxPages =
    overrides.maxPages ??
    process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES ??
    DEFAULT_MAX_PAGES;

  return {
    timeBudgetMs: clampWorkerBudgetMs(
      requestedBudget,
      DEFAULT_WORKER_BUDGET_MS,
      { min: 3_000 },
    ),
    maxPages: Math.min(Math.max(Number(requestedMaxPages) || 1, 1), 20),
  };
}

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
  // Dijeda: jangan membuat job baru sama sekali. Job lama (kalau ada) tetap
  // dibiarkan beserta cursor-nya supaya bisa dilanjutkan nanti.
  // Nol akses database: status job tetap bisa dibaca dashboard lewat
  // endpoint /sync/customers/status, jadi jalur ini tidak perlu query apa pun.
  if (!isCustomerSyncEnabled()) {
    return { created: false, ...customerSyncDisabledResult() };
  }

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
//
// `dependencies` mengikuti pola salesTransactionSyncService.processSalesPage:
// titik injeksi tipis supaya perilaku cursor dan guard halaman bisa diuji tanpa
// menembak API Runchise maupun database sungguhan.
async function processImportPage(client, job, dependencies = {}) {
  const fetchPage = dependencies.fetchPage || fetchCustomersPage;
  const locationIds = Array.isArray(job.location_ids) ? job.location_ids : [];
  const locationIndex = Number(job.current_location_index);
  if (locationIndex >= locationIds.length) return { completed: true, job: serializeJob(job) };

  const locationId = Number(locationIds[locationIndex]);
  const page = Number(job.current_page) || 1;
  // M-2: hard cap halaman, sejajar dengan jalur sales
  // (salesTransactionSyncService.processSalesPage) dan paginator di
  // runchiseService. Cursor `current_page` bertahan lintas invocation, jadi
  // tanpa cap ini `paging.next_page` yang tidak pernah null (endpoint customer
  // Runchise dilaporkan selalu melaporkan total_item 10000) membuat job tidak
  // akan pernah `completed`: cron */10 menit menggempur API selamanya, per
  // outlet, tanpa satu pun sinyal gagal. Satu invocation memang tidak hang
  // karena dibatasi maxPages + time budget -- justru itu yang membuat
  // kegagalannya tidak terlihat.
  assertPageWithinLimit('customer import worker', page, RUNCHISE_MAX_PAGES);
  // Retry dilakukan oleh invocation cron berikutnya dari cursor yang sama.
  // Retry HTTP internal dapat melampaui deadline sebelum checkpoint tersimpan.
  const data = await fetchPage(locationId, page, { retries: 0 });
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
  }

  // C-2: satu halaman (sampai 100 customer) diproses lewat SATU batch
  // (~3 query preload + beberapa statement bulk) alih-alih upsert per
  // customer (~6-10 round-trip x 100 customer = 600-1000 round-trip
  // sekuensial per halaman -- gampang melebihi time budget worker ini).
  // Kalau batch gagal total, jangan jatuh ke N+1. Lempar error agar worker
  // mengembalikan job ke queued dan mengulang halaman yang sama secara atomik.
  let results;
  try {
    results = await upsertRunchiseCustomersBatch(customers, locationId);
  } catch (error) {
    console.warn(
      `Batch impor customer Runchise gagal (location ${locationId}, page ${page}), halaman akan diulang: ${error.message}`,
    );
    throw error;
  }

  for (const result of results) {
    if (result.status === 'created') created++;
    else if (result.status === 'updated') updated++;
    else if (result.status === 'failed') failed++;
    else skippedConflicts++;
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

async function processCustomerImportSyncJob(options = {}, dependencies = {}) {
  const createClient = dependencies.createClient || createAdvisoryLockClient;
  // Dijeda: tidak memproses halaman apa pun dan TIDAK mengubah status job,
  // sehingga cursor terakhir tetap utuh untuk dilanjutkan setelah saklar
  // dinyalakan kembali.
  if (!isCustomerSyncEnabled()) {
    return customerSyncDisabledResult();
  }

  const client = createClient();
  let lockAcquired = false;
  let activeJobId = null;
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
    activeJobId = job.id;

    await client.query(
      `UPDATE "CustomerImportSyncJob"
       SET "status" = 'running', "heartbeat_at" = NOW(), "error" = NULL
       WHERE "id" = $1`,
      [job.id],
    );

    // Dibaca saat invocation (bukan saat module load), sehingga konfigurasi
    // deployment dan override test selalu menghasilkan nilai efektif yang sama.
    const workerConfig = getCustomerImportWorkerConfig(options);
    const deadline = Date.now() + workerConfig.timeBudgetMs;
    const safeMaxPages = workerConfig.maxPages;
    let pagesProcessed = 0;
    let serialized = serializeJob(job);

    do {
      const result = await processImportPage(client, job, dependencies);
      pagesProcessed++;
      serialized = result.job;
      if (result.completed) {
        return { status: serialized.status, job: serialized };
      }
      job = { ...job, ...result.job };
    } while (
      pagesProcessed < safeMaxPages &&
      hasTimeForNextRequest(deadline, RUNCHISE_REQUEST_TIMEOUT_MS)
    );

    return { status: 'running', job: serialized };
  } catch (error) {
    const message = String(error.message || error).slice(0, 4000);
    // Default: dikembalikan ke 'queued' agar percobaan berikutnya melanjutkan
    // dari cursor tersimpan, bukan mengulang job dari awal.
    //
    // M-2: melewati cap halaman BUKAN error sementara. Cursor sudah berada di
    // halaman yang melanggar cap, jadi requeue hanya membuat invocation cron
    // berikutnya mengulang halaman yang sama dan gagal lagi -- selamanya, tanpa
    // pernah terlihat. Job dihentikan sebagai 'failed' supaya muncul di
    // dashboard dan telemetry; enqueue harian berikutnya membuat job baru yang
    // bersih karena hanya job 'queued'/'running' yang menghalangi pembuatan.
    const isPageCapExceeded = error.code === 'RUNCHISE_MAX_PAGES_EXCEEDED';
    const nextStatus = isPageCapExceeded ? 'failed' : 'queued';
    // Dibatasi ke job yang benar-benar sedang dikerjakan invocation ini; baris
    // 'running' yatim dari invocation yang mati mendadak tidak boleh ikut
    // ditandai gagal oleh error yang bukan miliknya.
    if (activeJobId !== null) {
      await client
        .query(
          `UPDATE "CustomerImportSyncJob"
           SET "status" = $2,
               "error" = $1,
               "heartbeat_at" = NOW(),
               "finished_at" = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END
           WHERE "id" = $3`,
          [message, nextStatus, activeJobId],
        )
        .catch(() => {});
    }
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
  DEFAULT_WORKER_BUDGET_MS,
  DEFAULT_MAX_PAGES,
  createCustomerImportSyncJob,
  getCustomerImportWorkerConfig,
  getCustomerImportSyncJob,
  processCustomerImportSyncJob,
  processImportPage,
};
