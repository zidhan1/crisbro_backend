const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('C-1: Vercel menjadwalkan enqueue harian dan worker customer berkala secara terpisah', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'),
  );
  const schedules = new Map(
    config.crons.map((cron) => [cron.path, cron.schedule]),
  );

  assert.equal(
    schedules.get('/api/cron/runchise-sync/customers'),
    '15 12 * * *',
  );
  assert.equal(
    schedules.get('/api/cron/runchise-sync/customers-worker'),
    '*/10 * * * *',
  );
});

test('C-1: worker idle tidak membuat job baru', async () => {
  process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED = 'true';
  const { processCustomerImportSyncJob } = require('../src/services/customerImportSyncService');
  let insertCalls = 0;
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes('INSERT')) insertCalls++;
      return { rows: [] };
    },
  };
  const result = await processCustomerImportSyncJob({}, { createClient: () => client });
  assert.equal(result.status, 'idle');
  assert.equal(insertCalls, 0);
});
