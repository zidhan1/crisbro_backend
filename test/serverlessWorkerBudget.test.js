const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_WORKER_BUDGET_MS,
  SERVERLESS_MAX_DURATION_MS,
  SERVERLESS_SHUTDOWN_RESERVE_MS,
  clampWorkerBudgetMs,
  hasTimeForNextRequest,
} = require('../src/lib/serverlessBudget');
const {
  DEFAULT_WORKER_BUDGET_MS: CUSTOMER_IMPORT_DEFAULT_BUDGET_MS,
  getCustomerImportWorkerConfig,
} = require('../src/services/customerImportSyncService');

test('worker menghitung budget efektif di bawah batas runtime serverless', () => {
  assert.equal(SERVERLESS_MAX_DURATION_MS - SERVERLESS_SHUTDOWN_RESERVE_MS, MAX_WORKER_BUDGET_MS);
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

test('C-2: worker impor customer memakai default efektif 20 detik', () => {
  const originalBudget = process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS;
  const originalMaxPages = process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES;
  try {
    delete process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS;
    delete process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES;

    assert.equal(CUSTOMER_IMPORT_DEFAULT_BUDGET_MS, 20_000);
    assert.deepEqual(getCustomerImportWorkerConfig(), {
      timeBudgetMs: 20_000,
      maxPages: 10,
    });
  } finally {
    if (originalBudget === undefined) {
      delete process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS;
    } else {
      process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS = originalBudget;
    }
    if (originalMaxPages === undefined) {
      delete process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES;
    } else {
      process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES = originalMaxPages;
    }
  }
});

test('C-2: konfigurasi customer worker dibaca saat runtime dan dijepit aman', () => {
  const originalBudget = process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS;
  const originalMaxPages = process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES;
  try {
    process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS = '15000';
    process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES = '7';
    assert.deepEqual(getCustomerImportWorkerConfig(), {
      timeBudgetMs: 15_000,
      maxPages: 7,
    });

    process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS = '999999';
    process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES = '999';
    assert.deepEqual(getCustomerImportWorkerConfig(), {
      timeBudgetMs: 20_000,
      maxPages: 20,
    });
  } finally {
    if (originalBudget === undefined) {
      delete process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS;
    } else {
      process.env.RUNCHISE_CUSTOMER_WORKER_BUDGET_MS = originalBudget;
    }
    if (originalMaxPages === undefined) {
      delete process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES;
    } else {
      process.env.RUNCHISE_CUSTOMER_WORKER_MAX_PAGES = originalMaxPages;
    }
  }
});
