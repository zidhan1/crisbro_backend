// Load test terisolasi untuk sales worker. Tidak membaca DATABASE_URL, tidak
// memanggil API Runchise, dan tidak menyentuh cron. Semua data dibuat sebagai
// fixture deterministik di memori agar aman dijalankan lokal/CI.
const { performance } = require('node:perf_hooks');
const {
  processSalesPage,
} = require('../src/services/salesTransactionSyncService');
const {
  syncSalesTransactionReportsPage,
} = require('../src/services/syncService');

const STAGES = [1, 5, 10, 29];
const PAGES_PER_OUTLET = Number(process.env.LOAD_TEST_PAGES_PER_OUTLET) || 5;
const RECORDS_PER_PAGE = Number(process.env.LOAD_TEST_RECORDS_PER_PAGE) || 100;
const TRANSIENT_FAILURE_EVERY_REQUESTS =
  Number(process.env.LOAD_TEST_TRANSIENT_FAILURE_EVERY_REQUESTS) || 37;

function makeSale(locationId, page, index) {
  const id = locationId * 1_000_000 + page * 1_000 + index;
  const invalid = index % 97 === 0;
  const zeroPoints = index % 7 === 0;
  return {
    id: invalid ? null : id,
    customer_id: locationId * 100_000 + index,
    customer_name: `Fixture Customer ${index}`,
    customer_phone_number: `812000${String(index).padStart(4, '0')}`,
    customer_phone_number_country_code: 62,
    location_id: locationId,
    location_name: `Fixture Outlet ${locationId}`,
    sales_time: `2026-08-${String(((page - 1) % 7) + 5).padStart(2, '0')}T12:00:00+07:00`,
    sales_no: `LOAD-${id}`,
    receipt_no: `R-${id}`,
    status: 'completed',
    deleted: false,
    net_sales_after_tax: 50_000,
    metadata: {
      earned_point: zeroPoints ? 0 : 5,
      redeemed_point: zeroPoints ? 0 : index % 11 === 0 ? 10 : 0,
      available_point: 100,
    },
    payments: [
      { amount_receive: 50_000, change: 0, payment_method_name: 'Cash' },
    ],
    sale_detail_transactions: [],
  };
}

function createMeasuredDatabase(metrics) {
  const operation = (type, result) => {
    metrics.db_queries++;
    metrics.db_query_types[type] = (metrics.db_query_types[type] || 0) + 1;
    return Promise.resolve(result);
  };
  return {
    runchiseLocationCustomer: {
      findMany: () => operation('staging_lookup', []),
    },
    customer: {
      findMany: () => operation('customer_lookup', []),
    },
    $transaction: async (run) => {
      metrics.db_queries++;
      metrics.db_query_types.transaction =
        (metrics.db_query_types.transaction || 0) + 1;
      const tx = {
        $executeRaw: () => operation('bulk_data_statement', 1),
      };
      return run(tx);
    },
  };
}

function createCheckpointClient(job, metrics) {
  return {
    async query(_sql, params) {
      metrics.db_queries++;
      metrics.db_query_types.checkpoint_update =
        (metrics.db_query_types.checkpoint_update || 0) + 1;
      job.status = params[1];
      job.current_location_index = params[2];
      job.current_location = params[3];
      job.current_page = params[4];
      job.pages_processed += 1;
      job.processed += Number(params[5]) || 0;
      job.synced += Number(params[6]) || 0;
      job.skipped += Number(params[7]) || 0;
      return { rows: [{ ...job }] };
    },
  };
}

function sampleMemory(metrics) {
  const usage = process.memoryUsage();
  metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, usage.rss);
  metrics.peak_heap_used_bytes = Math.max(
    metrics.peak_heap_used_bytes,
    usage.heapUsed,
  );
}

async function runStage(outletCount) {
  if (global.gc) global.gc();
  const locationIds = Array.from({ length: outletCount }, (_, index) => 1001 + index);
  const job = {
    id: outletCount,
    status: 'running',
    location_ids: locationIds,
    current_location_index: 0,
    current_location: locationIds[0],
    current_page: 1,
    start_date: '2026-08-05',
    end_date: '2026-08-11',
    filters: { status: 'completed' },
    pages_processed: 0,
    processed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
  };
  const metrics = {
    outlets: outletCount,
    pages_per_outlet: PAGES_PER_OUTLET,
    records_per_page: RECORDS_PER_PAGE,
    expected_records: outletCount * PAGES_PER_OUTLET * RECORDS_PER_PAGE,
    runchise_requests: 0,
    retries: 0,
    failed_attempts: 0,
    db_queries: 0,
    db_query_types: {},
    peak_rss_bytes: 0,
    peak_heap_used_bytes: 0,
  };
  const db = createMeasuredDatabase(metrics);
  const client = createCheckpointClient(job, metrics);
  const failedOnce = new Set();
  let completed = false;
  const started = performance.now();
  sampleMemory(metrics);

  while (!completed) {
    const locationId = job.location_ids[job.current_location_index];
    const page = job.current_page;
    const requestKey = `${locationId}:${page}`;
    try {
      const result = await processSalesPage(client, job, {
        fetchPage: async () => {
          metrics.runchise_requests++;
          if (
            TRANSIENT_FAILURE_EVERY_REQUESTS > 0 &&
            metrics.runchise_requests % TRANSIENT_FAILURE_EVERY_REQUESTS === 0 &&
            !failedOnce.has(requestKey)
          ) {
            failedOnce.add(requestKey);
            metrics.failed_attempts++;
            throw Object.assign(new Error('Synthetic Runchise timeout'), {
              code: 'ETIMEDOUT',
            });
          }
          return {
            sales_transactions: Array.from(
              { length: RECORDS_PER_PAGE },
              (_, index) => makeSale(locationId, page, index),
            ),
            paging: {
              next_page: page < PAGES_PER_OUTLET ? page + 1 : null,
              total_item: PAGES_PER_OUTLET * RECORDS_PER_PAGE,
            },
          };
        },
        syncPage: (activeLocationId, sales) =>
          syncSalesTransactionReportsPage(activeLocationId, sales, db),
      });
      completed = result.completed;
      Object.assign(job, result.job);
    } catch (error) {
      if (error.code !== 'ETIMEDOUT') throw error;
      // Mensimulasikan invocation cron berikutnya: cursor tidak berubah dan
      // halaman yang sama dicoba kembali secara idempoten.
      metrics.retries++;
    }
    sampleMemory(metrics);
  }

  metrics.duration_ms = Number((performance.now() - started).toFixed(2));
  metrics.fetched = job.processed;
  metrics.synced = job.synced;
  metrics.skipped = job.skipped;
  metrics.failed = job.failed;
  metrics.request_failure_rate_percent = Number(
    ((metrics.failed_attempts / metrics.runchise_requests) * 100).toFixed(3),
  );
  metrics.final_record_failure_rate_percent = Number(
    ((job.failed / Math.max(job.processed, 1)) * 100).toFixed(3),
  );
  metrics.transient_recovery_rate_percent = metrics.failed_attempts
    ? Number(((metrics.retries / metrics.failed_attempts) * 100).toFixed(3))
    : 100;
  metrics.throughput_records_per_second = Number(
    ((job.processed / metrics.duration_ms) * 1000).toFixed(2),
  );
  return metrics;
}

async function main() {
  const results = [];
  for (const outletCount of STAGES) {
    const result = await runStage(outletCount);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  console.log(
    JSON.stringify({
      mode: 'isolated_fixture',
      production_cron_called: false,
      production_database_touched: false,
      runchise_api_called: false,
      customer_sync_enabled: false,
      results,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
