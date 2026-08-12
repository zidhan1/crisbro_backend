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

test('C-1: worker tidak membuat job baru ketika antrean idle', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/jobs/runchiseSyncCron.js'),
    'utf8',
  );
  const workerBody = source.match(
    /async function runCustomerImportWorkerJob\(\) \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(workerBody, 'fungsi worker customer harus tersedia');
  assert.match(workerBody, /processCustomerImportSyncJob/);
  assert.doesNotMatch(workerBody, /createCustomerImportSyncJob/);
});

