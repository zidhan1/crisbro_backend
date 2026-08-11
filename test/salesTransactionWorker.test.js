const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pageHasMore,
  processSalesTransactionSyncJob,
  processSalesPage,
} = require('../src/services/salesTransactionSyncService');

test('paging worker menghormati next_page dan fallback total_item', () => {
  assert.equal(pageHasMore({ paging: { next_page: 2 } }, [{}], 1), true);
  assert.equal(pageHasMore({ paging: { next_page: null } }, Array(100), 1), false);
  assert.equal(pageHasMore({ paging: { total_item: 250 } }, Array(100), 2), true);
  assert.equal(pageHasMore({ paging: { total_item: 200 } }, Array(100), 2), false);
});

test('satu halaman sukses memajukan cursor halaman dan menyimpan metrik', async () => {
  const updates = [];
  const client = {
    async query(sql, params) {
      updates.push({ sql, params });
      return {
        rows: [
          {
            id: 7,
            status: 'running',
            location_ids: [101, 202],
            current_location_index: 0,
            current_location: 101,
            current_page: 2,
            pages_processed: 1,
            processed: 2,
            synced: 1,
            skipped: 1,
            failed: 0,
          },
        ],
      };
    },
  };
  const fetched = [];
  const result = await processSalesPage(
    client,
    {
      id: 7,
      status: 'running',
      location_ids: [101, 202],
      current_location_index: 0,
      current_page: 1,
      start_date: '2026-08-01',
      end_date: '2026-08-11',
      filters: { status: 'completed' },
    },
    {
      fetchPage: async (page, params, options) => {
        fetched.push({ page, params, options });
        return {
          sales_transactions: [{ id: 1 }, { id: 2 }],
          paging: { next_page: 2 },
        };
      },
      syncPage: async (locationId, sales) => {
        assert.equal(locationId, 101);
        assert.equal(sales.length, 2);
        return { processed: 2, synced: 1, skipped: 1 };
      },
    },
  );

  assert.equal(result.completed, false);
  assert.equal(fetched[0].page, 1);
  assert.equal(fetched[0].params.location_id, 101);
  assert.equal(fetched[0].params.start_date, '2026-08-01');
  assert.deepEqual(fetched[0].options, { retries: 0 });
  assert.equal(updates[0].params[4], 2);
  assert.equal(updates[0].params[5], 2);
  assert.equal(updates[0].params[6], 1);
  assert.equal(updates[0].params[7], 1);
});

test('halaman terakhir pindah ke outlet berikutnya dan kembali ke page 1', async () => {
  let updateParams;
  const client = {
    async query(_sql, params) {
      updateParams = params;
      return {
        rows: [{
          id: 8,
          status: 'running',
          location_ids: [101, 202],
          current_location_index: 1,
          current_location: 202,
          current_page: 1,
        }],
      };
    },
  };
  await processSalesPage(
    client,
    {
      id: 8,
      location_ids: [101, 202],
      current_location_index: 0,
      current_page: 3,
      filters: {},
    },
    {
      fetchPage: async () => ({ sales_transactions: [], paging: { next_page: null } }),
      syncPage: async () => ({ processed: 0, synced: 0, skipped: 0 }),
    },
  );
  assert.equal(updateParams[2], 1);
  assert.equal(updateParams[3], 202);
  assert.equal(updateParams[4], 1);
});

test('kegagalan write tidak memajukan cursor job', async () => {
  let updateCalled = false;
  const client = {
    async query() {
      updateCalled = true;
      throw new Error('cursor seharusnya tidak diubah');
    },
  };
  await assert.rejects(
    processSalesPage(
      client,
      {
        id: 9,
        location_ids: [101],
        current_location_index: 0,
        current_page: 4,
        filters: {},
      },
      {
        fetchPage: async () => ({
          sales_transactions: [{ id: 1 }],
          paging: { next_page: 5 },
        }),
        syncPage: async () => {
          throw new Error('database gagal');
        },
      },
    ),
    /database gagal/,
  );
  assert.equal(updateCalled, false);
});

test('time budget menghentikan invocation dan menyisakan status running untuk dilanjutkan', async () => {
  const baseJob = {
    id: 10,
    status: 'queued',
    location_ids: [101],
    current_location_index: 0,
    current_location: 101,
    current_page: 1,
    filters: {},
    processed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
  };
  const client = {
    async connect() {},
    async end() {},
    async query(sql, params) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes("WHERE \"status\" IN ('queued', 'running')")) {
        return { rows: [baseJob] };
      }
      if (sql.includes("SET \"status\" = 'running'")) {
        return { rows: [{ ...baseJob, status: 'running' }] };
      }
      if (sql.includes('"pages_processed" = "pages_processed" + 1')) {
        return {
          rows: [{
            ...baseJob,
            status: 'running',
            current_page: 2,
            pages_processed: 1,
            processed: params[5],
            synced: params[6],
            skipped: params[7],
          }],
        };
      }
      throw new Error(`Query test tidak dikenali: ${sql}`);
    },
  };
  const clock = [0, 0, 9_000];
  let pagesFetched = 0;
  const result = await processSalesTransactionSyncJob(
    { timeBudgetMs: 8_000, maxPages: 10 },
    {
      createClient: () => client,
      now: () => clock.shift() ?? 9_000,
      fetchPage: async () => {
        pagesFetched++;
        return { sales_transactions: [{ id: 1 }], paging: { next_page: 2 } };
      },
      syncPage: async () => ({ processed: 1, synced: 1, skipped: 0 }),
    },
  );

  assert.equal(result.status, 'running');
  assert.equal(result.job.current_page, 2);
  assert.equal(pagesFetched, 1);
});
