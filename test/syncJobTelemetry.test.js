const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSyncJobTelemetry,
  normalizeJobResult,
  sanitizeError,
} = require('../src/services/syncJobTelemetryService');

test('hasil worker cursor dinormalisasi menjadi checkpoint dan counter umum', () => {
  const normalized = normalizeJobResult({
    status: 'running',
    job: {
      id: 42,
      current_location: 1042,
      current_location_index: 7,
      current_page: 13,
      start_date: '2026-08-05',
      end_date: '2026-08-11',
      processed: 4200,
      synced: 3815,
      skipped: 370,
      failed: 15,
    },
  });

  assert.deepEqual(normalized, {
    status: 'running',
    sourceJobId: '42',
    currentLocation: 1042,
    cursor: {
      location_index: 7,
      page: 13,
      start_date: '2026-08-05',
      end_date: '2026-08-11',
    },
    fetched: 4200,
    synced: 3815,
    skipped: 370,
    failed: 15,
  });
});

test('customer sync disabled dicatat sebagai paused', () => {
  assert.equal(
    normalizeJobResult({ status: 'disabled', skipped: true }).status,
    'paused',
  );
});

test('error telemetry hanya menyimpan code dan message terpangkas, bukan stack/header', () => {
  const error = new Error('upstream gagal');
  error.code = 'ETIMEDOUT';
  error.config = { headers: { Authorization: 'secret' } };
  const safe = sanitizeError(error);
  assert.deepEqual(safe, { code: 'ETIMEDOUT', message: 'upstream gagal' });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(Object.hasOwn(safe, 'stack'), false);
});

test('lifecycle telemetry menyimpan queued, running, completed, durasi, memori, dan sukses terakhir', async () => {
  const calls = [];
  const client = {
    async connect() {},
    async end() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO')) return { rows: [{ id: '99' }] };
      return { rows: [] };
    },
  };
  const telemetry = createSyncJobTelemetry({ createClient: () => client });
  const id = await telemetry.enqueue('sales');
  await telemetry.markRunning(id);
  await telemetry.finish(id, {
    result: {
      status: 'completed',
      job: { id: 11, processed: 100, synced: 80, skipped: 19, failed: 1 },
    },
    durationMs: 7240,
    memory: { rss: 150_000_000, heapUsed: 73_000_000 },
  });

  assert.equal(id, '99');
  assert.match(calls[0].sql, /'queued'/);
  assert.match(calls[1].sql, /'running'/);
  assert.equal(calls[2].params[1], 'completed');
  assert.equal(calls[2].params[2], '11');
  assert.equal(calls[2].params[5], 7240);
  assert.equal(calls[2].params[6], 150_000_000);
  assert.equal(calls[2].params[8], 100);
  assert.equal(calls[2].params[9], 80);
  assert.equal(calls[2].params[10], 19);
  assert.equal(calls[2].params[11], 1);
});

test('failure menyimpan status failed dan error terakhir', async () => {
  let failureCall;
  const client = {
    async connect() {},
    async end() {},
    async query(sql, params) {
      failureCall = { sql, params };
      return { rows: [] };
    },
  };
  const telemetry = createSyncJobTelemetry({ createClient: () => client });
  const error = Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' });
  await telemetry.fail('100', {
    error,
    durationMs: 6001,
    memory: { rss: 120_000_000, heapUsed: 60_000_000 },
  });

  assert.match(failureCall.sql, /"status" = 'failed'/);
  assert.equal(failureCall.params[0], '100');
  assert.equal(failureCall.params[1], 6001);
  assert.equal(failureCall.params[4], 'ETIMEDOUT');
  assert.equal(failureCall.params[5], 'request timeout');
});
