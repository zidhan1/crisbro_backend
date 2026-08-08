const { Client } = require('pg');
const { fetchCustomersPage } = require('./runchiseService');
const {
  isCustomerSyncEnabled,
  customerSyncDisabledResult,
} = require('../lib/customerSyncToggle');

const CUSTOMER_TIMESTAMP_WORKER_LOCK_ID = 750954835;
const DEFAULT_WORKER_BUDGET_MS = 20_000;

function createDatabaseClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

function parseRunchiseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timestampsEqual(first, second) {
  if (!first && !second) return true;
  if (!first || !second) return false;
  return new Date(first).getTime() === new Date(second).getTime();
}

function normalizeTimestampRows(customers) {
  const rowByRunchiseId = new Map();
  let invalid = 0;

  for (const customer of customers ?? []) {
    const runchiseId = Number(customer.id);
    if (!Number.isInteger(runchiseId) || runchiseId <= 0) {
      invalid++;
      continue;
    }

    const createdAt = parseRunchiseTimestamp(customer.created_at);
    const updatedAt = parseRunchiseTimestamp(customer.updated_at);
    if (!createdAt && !updatedAt) {
      invalid++;
      continue;
    }

    rowByRunchiseId.set(runchiseId, { runchiseId, createdAt, updatedAt });
  }

  return { rows: [...rowByRunchiseId.values()], invalid };
}

async function getLocalTimestampMap(client, runchiseIds) {
  if (runchiseIds.length === 0) return new Map();
  const result = await client.query(
    `
      SELECT "runchise_id", "runchise_created_at", "runchise_updated_at"
      FROM "Customer"
      WHERE "runchise_id" = ANY($1::integer[])
    `,
    [runchiseIds],
  );
  return new Map(result.rows.map((row) => [Number(row.runchise_id), row]));
}

async function bulkUpdateTimestampPage(client, rows) {
  if (rows.length === 0) return 0;
  const values = [];
  const tuples = rows.map((row, index) => {
    const offset = index * 3;
    values.push(row.runchiseId, row.createdAt, row.updatedAt);
    return `($${offset + 1}::integer, $${offset + 2}::timestamp, $${offset + 3}::timestamp)`;
  });

  const result = await client.query(
    `
      UPDATE "Customer" AS customer
      SET
        "runchise_created_at" = COALESCE(source.runchise_created_at, customer."runchise_created_at"),
        "runchise_updated_at" = COALESCE(source.runchise_updated_at, customer."runchise_updated_at")
      FROM (VALUES ${tuples.join(', ')}) AS source(
        runchise_id,
        runchise_created_at,
        runchise_updated_at
      )
      WHERE customer."runchise_id" = source.runchise_id
        AND (
          customer."runchise_created_at" IS DISTINCT FROM
            COALESCE(source.runchise_created_at, customer."runchise_created_at")
          OR customer."runchise_updated_at" IS DISTINCT FROM
            COALESCE(source.runchise_updated_at, customer."runchise_updated_at")
        )
    `,
    values,
  );
  return result.rowCount;
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

async function getCustomerTimestampSyncJob() {
  const client = createDatabaseClient();
  try {
    await client.connect();
    const result = await client.query(
      `
        SELECT * FROM "CustomerTimestampSyncJob"
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

async function createCustomerTimestampSyncJob() {
  // Ikut dijeda: worker ini juga menyapu endpoint customer Runchise halaman
  // demi halaman untuk seluruh outlet. Nol akses database saat dijeda.
  if (!isCustomerSyncEnabled()) {
    return { created: false, ...customerSyncDisabledResult() };
  }

  const client = createDatabaseClient();
  try {
    await client.connect();
    const existing = await client.query(
      `SELECT * FROM "CustomerTimestampSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    if (existing.rows[0]) {
      return { created: false, job: serializeJob(existing.rows[0]) };
    }

    const locationsResult = await client.query(
      `
        SELECT DISTINCT COALESCE("runchise_id", "id")::integer AS runchise_id
        FROM "Location"
        WHERE "is_outlet" = TRUE AND "is_active" = TRUE
        ORDER BY runchise_id
      `,
    );
    const locationIds = locationsResult.rows
      .map((row) => Number(row.runchise_id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (locationIds.length === 0) {
      // Fallback lama ke ID 1 menunjuk outlet yang bukan milik Crisbar, membuat
      // job berjalan sampai selesai tanpa memperbarui satu baris pun.
      const fallback = Number(process.env.RUNCHISE_SYNC_LOCATION_ID);

      if (!Number.isInteger(fallback) || fallback <= 0) {
        throw new Error(
          'Tidak ada outlet aktif di tabel Location dan RUNCHISE_SYNC_LOCATION_ID belum diisi',
        );
      }

      locationIds.push(fallback);
    }
    const targetResult = await client.query(
      `SELECT COUNT(*)::integer AS total FROM "Customer" WHERE "runchise_id" IS NOT NULL`,
    );

    try {
      const inserted = await client.query(
        `
          INSERT INTO "CustomerTimestampSyncJob" (
            "status", "location_ids", "current_location", "target_total"
          ) VALUES ('queued', $1::jsonb, $2, $3)
          RETURNING *
        `,
        [
          JSON.stringify(locationIds),
          locationIds[0],
          Number(targetResult.rows[0].total),
        ],
      );
      return { created: true, job: serializeJob(inserted.rows[0]) };
    } catch (error) {
      if (error.code !== '23505') throw error;
      const raced = await client.query(
        `SELECT * FROM "CustomerTimestampSyncJob"
         WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
      );
      return { created: false, job: serializeJob(raced.rows[0]) };
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function processTimestampPage(client, job) {
  const locationIds = Array.isArray(job.location_ids) ? job.location_ids : [];
  const locationIndex = Number(job.current_location_index);
  if (locationIndex >= locationIds.length) return { completed: true };

  const locationId = Number(locationIds[locationIndex]);
  const page = Number(job.current_page) || 1;
  const data = await fetchCustomersPage(locationId, page);
  const customers = Array.isArray(data.customers) ? data.customers : [];
  const { rows, invalid } = normalizeTimestampRows(customers);
  const localById = await getLocalTimestampMap(
    client,
    rows.map((row) => row.runchiseId),
  );
  const changedRows = [];
  let unchanged = 0;
  let unmatched = 0;

  for (const row of rows) {
    const local = localById.get(row.runchiseId);
    if (!local) {
      unmatched++;
      continue;
    }
    const createdAt = row.createdAt ?? local.runchise_created_at;
    const updatedAt = row.updatedAt ?? local.runchise_updated_at;
    if (
      timestampsEqual(local.runchise_created_at, createdAt) &&
      timestampsEqual(local.runchise_updated_at, updatedAt)
    ) {
      unchanged++;
    } else {
      changedRows.push(row);
    }
  }

  await client.query('BEGIN');
  try {
    const updated = await bulkUpdateTimestampPage(client, changedRows);
    const hasNextPage =
      data.paging?.next_page !== null && data.paging?.next_page !== undefined;
    const nextLocationIndex = hasNextPage ? locationIndex : locationIndex + 1;
    const nextPage = hasNextPage
      ? Number(data.paging.next_page) || page + 1
      : 1;
    const completed = nextLocationIndex >= locationIds.length;
    const nextLocation = completed
      ? null
      : Number(locationIds[nextLocationIndex]);
    const result = await client.query(
      `
        UPDATE "CustomerTimestampSyncJob"
        SET
          "status" = $2,
          "current_location_index" = $3,
          "current_location" = $4,
          "current_page" = $5,
          "total_api" = "total_api" + $6,
          "processed" = "processed" + $7,
          "updated" = "updated" + $8,
          "unchanged" = "unchanged" + $9,
          "unmatched" = "unmatched" + $10,
          "invalid" = "invalid" + $11,
          "heartbeat_at" = NOW(),
          "finished_at" = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
          "error" = NULL
        WHERE "id" = $1
        RETURNING *
      `,
      [
        job.id,
        completed ? 'completed' : 'running',
        nextLocationIndex,
        nextLocation,
        nextPage,
        page === 1 ? Number(data.paging?.total_item ?? customers.length) : 0,
        customers.length,
        updated,
        unchanged,
        unmatched,
        invalid,
      ],
    );
    await client.query('COMMIT');
    return { completed, job: serializeJob(result.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function processCustomerTimestampSyncJob({
  timeBudgetMs = DEFAULT_WORKER_BUDGET_MS,
  maxPages = 1,
} = {}) {
  if (!isCustomerSyncEnabled()) {
    return customerSyncDisabledResult();
  }

  const client = createDatabaseClient();
  let lockAcquired = false;
  try {
    await client.connect();
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [CUSTOMER_TIMESTAMP_WORKER_LOCK_ID],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      return {
        status: 'already_running',
        job: await getCustomerTimestampSyncJob(),
      };
    }

    const active = await client.query(
      `SELECT * FROM "CustomerTimestampSyncJob"
       WHERE "status" IN ('queued', 'running') ORDER BY "id" DESC LIMIT 1`,
    );
    let job = active.rows[0];
    if (!job)
      return { status: 'idle', job: await getCustomerTimestampSyncJob() };

    await client.query(
      `UPDATE "CustomerTimestampSyncJob"
       SET "status" = 'running', "heartbeat_at" = NOW(), "error" = NULL
       WHERE "id" = $1`,
      [job.id],
    );

    const deadline =
      Date.now() +
      Math.min(Math.max(Number(timeBudgetMs) || 20_000, 5_000), 25_000);
    const safeMaxPages = Math.min(Math.max(Number(maxPages) || 1, 1), 10);
    let pagesProcessed = 0;
    do {
      const result = await processTimestampPage(client, job);
      pagesProcessed++;
      job = result.job;
      if (result.completed) return { status: 'completed', job };
    } while (pagesProcessed < safeMaxPages && Date.now() < deadline);

    return { status: 'running', job: serializeJob(job) };
  } catch (error) {
    const message = String(error.message || error).slice(0, 4000);
    await client
      .query(
        `UPDATE "CustomerTimestampSyncJob"
         SET "status" = 'queued', "error" = $1, "heartbeat_at" = NOW()
         WHERE "status" = 'running'`,
        [message],
      )
      .catch(() => {});
    throw error;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [
          CUSTOMER_TIMESTAMP_WORKER_LOCK_ID,
        ])
        .catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

module.exports = {
  createCustomerTimestampSyncJob,
  getCustomerTimestampSyncJob,
  processCustomerTimestampSyncJob,
  normalizeTimestampRows,
};
