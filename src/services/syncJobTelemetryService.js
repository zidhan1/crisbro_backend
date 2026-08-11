const { Client } = require('pg');

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const ALLOWED_STATUSES = new Set([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
]);

function createDatabaseClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

function nonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.trunc(number), 2_147_483_647);
}

function memorySnapshot() {
  if (typeof process.memoryUsage !== 'function') return null;
  const memory = process.memoryUsage();
  return {
    rss: nonNegativeInt(memory.rss),
    heapUsed: nonNegativeInt(memory.heapUsed),
  };
}

function normalizeJobResult(result) {
  const wrapper = result && typeof result === 'object' ? result : {};
  const job = wrapper.job && typeof wrapper.job === 'object' ? wrapper.job : wrapper;
  const rawStatus = String(wrapper.status ?? job.status ?? '').toLowerCase();
  let status = 'completed';
  if (['disabled', 'paused'].includes(rawStatus)) status = 'paused';
  else if (['queued', 'running', 'already_running'].includes(rawStatus)) status = 'running';
  else if (['failed', 'error'].includes(rawStatus)) status = 'failed';

  const created = nonNegativeInt(job.created ?? wrapper.created_count);
  const updated = nonNegativeInt(job.updated ?? wrapper.updated);
  const currentPage = Number(job.current_page ?? job.page);
  const currentLocationIndex = Number(job.current_location_index);
  const rawCurrentLocation = job.current_location ?? job.location_id;
  const cursor = {
    ...(Number.isInteger(currentLocationIndex) && {
      location_index: currentLocationIndex,
    }),
    ...(Number.isInteger(currentPage) && { page: currentPage }),
    ...(job.phase ? { phase: String(job.phase) } : {}),
    ...(job.start_date ? { start_date: String(job.start_date) } : {}),
    ...(job.end_date ? { end_date: String(job.end_date) } : {}),
  };

  return {
    status,
    sourceJobId: job.id === undefined || job.id === null ? null : String(job.id),
    currentLocation:
      rawCurrentLocation !== null &&
      rawCurrentLocation !== undefined &&
      Number.isInteger(Number(rawCurrentLocation))
        ? Number(rawCurrentLocation)
        : null,
    cursor: Object.keys(cursor).length > 0 ? cursor : null,
    fetched: nonNegativeInt(
      job.fetched ??
        job.processed ??
        job.total ??
        job.total_api ??
        job.api_scanned ??
        wrapper.total,
    ),
    synced: nonNegativeInt(job.synced ?? (created + updated)),
    skipped: nonNegativeInt(
      job.skipped ?? job.skipped_conflicts ?? wrapper.skipped_count,
    ),
    failed: nonNegativeInt(job.failed ?? wrapper.failed),
  };
}

function sanitizeError(error) {
  const code = error?.code ? String(error.code).slice(0, 120) : null;
  // Hanya message yang dipangkas; stack, request config, header, dan response
  // upstream sengaja tidak pernah masuk database telemetry.
  const message = String(error?.message || error || 'Unknown error').slice(
    0,
    MAX_ERROR_MESSAGE_LENGTH,
  );
  return { code, message };
}

async function withClient(createClient, operation) {
  const client = createClient();
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function createSyncJobTelemetry({ createClient = createDatabaseClient } = {}) {
  return {
    async enqueue(jobName) {
      return withClient(createClient, async (client) => {
        const result = await client.query(
          `INSERT INTO "SyncJobTelemetry" (
             "job_name", "status", "last_started_at"
           ) VALUES ($1, 'queued', NOW()) RETURNING "id"`,
          [jobName],
        );
        return result.rows[0]?.id ?? null;
      });
    },

    async markRunning(id) {
      if (id === null || id === undefined) return;
      await withClient(createClient, (client) =>
        client.query(
          `UPDATE "SyncJobTelemetry"
           SET "status" = 'running', "last_started_at" = NOW(),
               "updated_at" = NOW()
           WHERE "id" = $1`,
          [id],
        ),
      );
    },

    async finish(id, { result, durationMs, memory, lockSkipped = false }) {
      if (id === null || id === undefined) return;
      const normalized = normalizeJobResult(result);
      const status = ALLOWED_STATUSES.has(normalized.status)
        ? normalized.status
        : 'completed';
      await withClient(createClient, (client) =>
        client.query(
          `UPDATE "SyncJobTelemetry"
           SET "status" = $2,
               "source_job_id" = $3,
               "current_location" = $4,
               "cursor" = $5::jsonb,
               "duration_ms" = $6,
               "memory_rss_bytes" = $7,
               "memory_heap_used_bytes" = $8,
               "fetched" = $9,
               "synced" = $10,
               "skipped" = $11,
               "failed" = $12,
               "last_success_at" = CASE
                 WHEN $2 IN ('completed', 'running') AND $13 = FALSE THEN NOW()
                 ELSE "last_success_at"
               END,
               "updated_at" = NOW()
           WHERE "id" = $1`,
          [
            id,
            lockSkipped ? 'completed' : status,
            normalized.sourceJobId,
            normalized.currentLocation,
            normalized.cursor ? JSON.stringify(normalized.cursor) : null,
            nonNegativeInt(durationMs),
            memory?.rss ?? null,
            memory?.heapUsed ?? null,
            normalized.fetched,
            normalized.synced,
            normalized.skipped + (lockSkipped ? 1 : 0),
            normalized.failed,
            lockSkipped,
          ],
        ),
      );
    },

    async fail(id, { error, durationMs, memory }) {
      if (id === null || id === undefined) return;
      const safeError = sanitizeError(error);
      await withClient(createClient, (client) =>
        client.query(
          `UPDATE "SyncJobTelemetry"
           SET "status" = 'failed', "duration_ms" = $2,
               "memory_rss_bytes" = $3,
               "memory_heap_used_bytes" = $4,
               "failed" = GREATEST("failed", 1),
               "last_error_code" = $5,
               "last_error_message" = $6,
               "last_error_at" = NOW(), "updated_at" = NOW()
           WHERE "id" = $1`,
          [
            id,
            nonNegativeInt(durationMs),
            memory?.rss ?? null,
            memory?.heapUsed ?? null,
            safeError.code,
            safeError.message,
          ],
        ),
      );
    },
  };
}

async function listSyncJobTelemetry(
  { limit = 100, jobName = null, status = null } = {},
  { createClient = createDatabaseClient } = {},
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return withClient(createClient, async (client) => {
    const result = await client.query(
      `SELECT * FROM "SyncJobTelemetry"
       WHERE ($1::text IS NULL OR "job_name" = $1)
         AND ($2::text IS NULL OR "status" = $2)
       ORDER BY "last_started_at" DESC
       LIMIT $3`,
      [jobName || null, status || null, safeLimit],
    );
    return result.rows;
  });
}

module.exports = {
  createSyncJobTelemetry,
  listSyncJobTelemetry,
  memorySnapshot,
  normalizeJobResult,
  sanitizeError,
};
