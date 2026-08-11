const { performance } = require('node:perf_hooks');
const { PrismaClient } = require('@prisma/client');
const {
  syncSalesTransactionReportsPage,
} = require('../src/services/syncService');

const STAGES = [1, 5, 10, 29];
const PAGES_PER_OUTLET = Number(process.env.LOAD_TEST_PAGES_PER_OUTLET) || 5;
const RECORDS_PER_PAGE = Number(process.env.LOAD_TEST_RECORDS_PER_PAGE) || 100;

function requireDisposableDatabaseUrl() {
  const value = process.env.LOAD_TEST_DATABASE_URL;
  if (!value) throw new Error('LOAD_TEST_DATABASE_URL wajib diisi');
  const url = new URL(value);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!localHosts.has(url.hostname) || !/(load|test)/i.test(database)) {
    throw new Error(
      'Load test ditolak: database harus berada di loopback dan namanya memuat "load" atau "test"',
    );
  }
  return value;
}

function makeSale(locationId, page, index) {
  const id = BigInt(locationId) * 100_000n + BigInt(page * 1_000 + index);
  const invalid = index % 97 === 0;
  const zeroPoints = index % 7 === 0;
  return {
    id: invalid ? null : Number(id),
    customer_id: locationId * 1_000 + index,
    customer_name: `PG Fixture Customer ${index}`,
    customer_phone_number: `812000${String(index).padStart(4, '0')}`,
    customer_phone_number_country_code: 62,
    location_id: locationId,
    location_name: `PG Fixture Outlet ${locationId}`,
    sales_time: `2026-08-${String(((page - 1) % 7) + 5).padStart(2, '0')}T12:00:00+07:00`,
    sales_no: `PG-${id}`,
    receipt_no: `R-${id}`,
    status: 'completed',
    deleted: false,
    net_sales_after_tax: 50_000,
    metadata: {
      earned_point: zeroPoints ? 0 : 5,
      redeemed_point: zeroPoints ? 0 : index % 11 === 0 ? 10 : 0,
      available_point: 100,
    },
    payments: [{ amount_receive: 50_000, change: 0, payment_method_name: 'Cash' }],
    sale_detail_transactions: [],
  };
}

function memoryPeak(peak) {
  const usage = process.memoryUsage();
  peak.rss = Math.max(peak.rss, usage.rss);
  peak.heap = Math.max(peak.heap, usage.heapUsed);
}

async function runStage(prisma, outletCount, queryCounter) {
  const stageBase = 10_000 + outletCount * 100;
  const peak = { rss: 0, heap: 0 };
  const beforeQueries = queryCounter.count;
  const started = performance.now();
  let fetched = 0;
  let synced = 0;
  let skipped = 0;
  memoryPeak(peak);

  for (let outlet = 0; outlet < outletCount; outlet++) {
    const locationId = stageBase + outlet;
    for (let page = 1; page <= PAGES_PER_OUTLET; page++) {
      const sales = Array.from(
        { length: RECORDS_PER_PAGE },
        (_, index) => makeSale(locationId, page, index),
      );
      const result = await syncSalesTransactionReportsPage(locationId, sales, prisma);
      fetched += sales.length;
      synced += result.synced;
      skipped += result.skipped;
      memoryPeak(peak);
    }
  }

  const workloadQueries = queryCounter.count - beforeQueries;
  const durationMs = performance.now() - started;
  const stored = await prisma.customerSalesTransactionReport.count({
    where: { source_location_id: { gte: stageBase, lt: stageBase + outletCount } },
  });
  const expectedStored = synced;
  if (stored !== expectedStored) {
    throw new Error(`Integritas gagal pada ${outletCount} outlet: ${stored} != ${expectedStored}`);
  }

  return {
    outlets: outletCount,
    pages: outletCount * PAGES_PER_OUTLET,
    fetched,
    synced,
    skipped,
    stored,
    duration_ms: Number(durationMs.toFixed(2)),
    peak_rss_mib: Number((peak.rss / 1024 / 1024).toFixed(2)),
    peak_heap_mib: Number((peak.heap / 1024 / 1024).toFixed(2)),
    postgres_queries: workloadQueries,
    queries_per_page: Number((workloadQueries / (outletCount * PAGES_PER_OUTLET)).toFixed(2)),
    failure_percent: 0,
  };
}

async function main() {
  const datasourceUrl = requireDisposableDatabaseUrl();
  const queryCounter = { count: 0 };
  const prisma = new PrismaClient({
    datasourceUrl,
    log: [{ emit: 'event', level: 'query' }],
  });
  prisma.$on('query', () => queryCounter.count++);

  try {
    await prisma.$connect();
    const results = [];
    for (const stage of STAGES) {
      results.push(await runStage(prisma, stage, queryCounter));
      console.log(JSON.stringify(results.at(-1)));
    }
    console.log(JSON.stringify({ mode: 'disposable_postgresql', results }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
