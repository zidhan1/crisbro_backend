const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_WORKER_BUDGET_MS,
  SERVERLESS_MAX_DURATION_MS,
  SERVERLESS_SHUTDOWN_RESERVE_MS,
  clampWorkerBudgetMs,
  hasTimeForNextRequest,
} = require('../src/lib/serverlessBudget');

test('durasi Vercel sama dengan kontrak runtime dan menyisakan reserve 10 detik', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'),
  );

  assert.equal(
    config.functions['api/index.js'].maxDuration * 1000,
    SERVERLESS_MAX_DURATION_MS,
  );
  assert.equal(SERVERLESS_SHUTDOWN_RESERVE_MS, 10_000);
  assert.equal(MAX_WORKER_BUDGET_MS, 20_000);
});

test('halaman baru hanya boleh dimulai jika satu timeout request masih muat', () => {
  const deadline = 20_000;

  assert.equal(hasTimeForNextRequest(deadline, 8_000, 11_999), true);
  assert.equal(hasTimeForNextRequest(deadline, 8_000, 12_000), false);
  assert.equal(hasTimeForNextRequest(deadline, 8_000, 12_001), false);
  assert.equal(hasTimeForNextRequest(deadline, 8_000, 19_999), false);
});

test('budget environment berlebih dan invalid tidak dapat melewati batas worker', () => {
  assert.equal(clampWorkerBudgetMs(25_000, 8_000), 20_000);
  assert.equal(clampWorkerBudgetMs(999_999, 8_000), 20_000);
  assert.equal(clampWorkerBudgetMs('invalid', 8_000), 8_000);
  assert.equal(clampWorkerBudgetMs(-1, 8_000), 8_000);
  assert.equal(clampWorkerBudgetMs(100, 8_000, { min: 3_000 }), 3_000);
});

test('semua worker cursor customer dan sales menonaktifkan retry HTTP internal', () => {
  const sources = [
    'customerImportSyncService.js',
    'customerTimestampSyncService.js',
    'salesTransactionSyncService.js',
  ].map((name) =>
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', name), 'utf8'),
  );

  for (const source of sources) {
    assert.match(source, /fetchPage\([^;]+\{ retries: 0 \}\)/s);
  }
});
