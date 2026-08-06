const test = require('node:test');
const assert = require('node:assert/strict');
const {
  syncSalesAcrossLocations,
} = require('../src/lib/salesTransactionSyncCoverage');

function result(locationId, synced, total = synced) {
  return {
    location_id: locationId,
    synced,
    total,
    skipped: 0,
    skipped_zero_points: 0,
    deleted_zero_points: 0,
  };
}

test('mengiterasi dan mengagregasi seluruh outlet secara sekuensial', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;

  const summary = await syncSalesAcrossLocations({
    locationIds: [101, 202, 303],
    syncLocation: async (locationId) => {
      calls.push(locationId);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return result(locationId, 2, 3);
    },
  });

  assert.deepEqual(calls, [101, 202, 303]);
  assert.equal(maxActive, 1);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.locations_total, 3);
  assert.equal(summary.locations_completed, 3);
  assert.equal(summary.locations_failed, 0);
  assert.equal(summary.synced, 6);
  assert.equal(summary.total, 9);
});

test('kegagalan satu outlet tidak menghentikan sinkronisasi outlet lain', async () => {
  const calls = [];
  const errors = [];
  const summary = await syncSalesAcrossLocations({
    locationIds: [101, 202, 303],
    syncLocation: async (locationId) => {
      calls.push(locationId);
      if (locationId === 202) throw new Error('API timeout');
      return result(locationId, 1);
    },
    logger: { error: (...args) => errors.push(args) },
  });

  assert.deepEqual(calls, [101, 202, 303]);
  assert.equal(summary.status, 'completed_with_errors');
  assert.equal(summary.locations_completed, 2);
  assert.equal(summary.locations_failed, 1);
  assert.deepEqual(summary.failures, [
    { location_id: 202, error: 'API timeout' },
  ]);
  assert.equal(errors.length, 1);
});

test('melempar error terukur bila seluruh outlet gagal', async () => {
  await assert.rejects(
    () =>
      syncSalesAcrossLocations({
        locationIds: [101, 202],
        syncLocation: async () => {
          throw new Error('upstream unavailable');
        },
        logger: { error: () => {} },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Sinkronisasi sales gagal untuk seluruh 2 outlet',
      );
      assert.equal(error.syncSummary.status, 'failed');
      assert.equal(error.syncSummary.locations_failed, 2);
      assert.equal(error.syncSummary.locations_completed, 0);
      return true;
    },
  );
});
