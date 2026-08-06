const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUNCHISE_REQUEST_TIMEOUT_MS,
  RUNCHISE_MAX_RETRIES,
  RUNCHISE_MAX_PAGES,
  getRetryBudgetMs,
  assertPageWithinLimit,
  requestWithRetry,
  runchiseClient,
} = require('../src/services/runchiseService');

test('timeout dan worst-case retry budget selalu di bawah 30 detik', () => {
  assert.ok(RUNCHISE_REQUEST_TIMEOUT_MS >= 1000);
  assert.ok(RUNCHISE_REQUEST_TIMEOUT_MS <= 8000);
  assert.ok(RUNCHISE_MAX_RETRIES >= 0);
  assert.ok(RUNCHISE_MAX_RETRIES <= 2);
  assert.equal(runchiseClient.defaults.timeout, RUNCHISE_REQUEST_TIMEOUT_MS);
  assert.ok(getRetryBudgetMs(999) <= 25500);
  assert.ok(getRetryBudgetMs(999) < 30000);
});

test('page terakhir diterima dan halaman setelah hard cap ditolak terukur', () => {
  assert.doesNotThrow(() =>
    assertPageWithinLimit('customers', RUNCHISE_MAX_PAGES),
  );
  assert.throws(
    () => assertPageWithinLimit('customers', RUNCHISE_MAX_PAGES + 1),
    (error) => {
      assert.equal(error.code, 'RUNCHISE_MAX_PAGES_EXCEEDED');
      assert.equal(error.resource, 'customers');
      assert.equal(error.maxPages, RUNCHISE_MAX_PAGES);
      return true;
    },
  );
});

test('override retry berlebih tetap dikunci oleh budget global', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      requestWithRetry(
        'test upstream',
        async () => {
          attempts++;
          const error = new Error('timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        },
        { retries: 999 },
      ),
    /timeout/,
  );
  assert.equal(attempts, RUNCHISE_MAX_RETRIES + 1);
});
