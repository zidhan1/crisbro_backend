const {
  importSalesTransactions,
  jakartaRange,
} = require('./importRunchiseSalesTransactions');

/**
 * Daftar backfill transaksi historis.
 *
 * Untuk menambahkan lokasi/periode lain, tambahkan object baru. Importer akan
 * menjalankan job secara sekuensial agar API Runchise tidak dibanjiri request.
 * Snapshot customer hanya diambil sekali untuk setiap source_location_id dalam
 * satu eksekusi, lalu dipakai untuk semua periode lokasi tersebut.
 */
const IMPORT_JOBS = [
  {
    location_name: 'Widyatama',
    source_location_id: 4614,
    start_date: '2026-07-27',
    end_date: '2026-08-02',
    expected_total: null,
  },

  // Contoh penambahan job berikutnya:
  // {
  //   location_name: 'Ujung Berung',
  //   source_location_id: 4561,
  //   start_date: '2024-09-01',
  //   end_date: '2024-09-30',
  // },
];

function validateJob(job, index) {
  const label = `IMPORT_JOBS[${index}]`;
  const locationId = Number(job?.source_location_id);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new Error(`${label}.source_location_id harus berupa integer positif`);
  }
  if (!job.location_name || !String(job.location_name).trim()) {
    throw new Error(`${label}.location_name wajib diisi`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(job.start_date))) {
    throw new Error(`${label}.start_date harus memakai format YYYY-MM-DD`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(job.end_date))) {
    throw new Error(`${label}.end_date harus memakai format YYYY-MM-DD`);
  }
  for (const [field, value] of [
    ['start_date', job.start_date],
    ['end_date', job.end_date],
  ]) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`${label}.${field} bukan tanggal yang valid: ${value}`);
    }
  }

  // Helper ini sekaligus memastikan start_date <= end_date dan tanggal dapat
  // diperlakukan sebagai batas hari Asia/Jakarta.
  jakartaRange(job.start_date, job.end_date);
  const expectedTotal = job.expected_total == null ? null : Number(job.expected_total);
  if (expectedTotal !== null && (!Number.isInteger(expectedTotal) || expectedTotal < 0)) {
    throw new Error(`${label}.expected_total harus berupa integer non-negatif`);
  }

  return {
    location_name: String(job.location_name).trim(),
    source_location_id: locationId,
    start_date: job.start_date,
    end_date: job.end_date,
    expected_total: expectedTotal,
  };
}

function validatedJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('IMPORT_JOBS minimal berisi satu job');
  }

  const seen = new Set();
  return jobs.map((job, index) => {
    const validated = validateJob(job, index);
    const key = [
      validated.source_location_id,
      validated.start_date,
      validated.end_date,
    ].join(':');
    if (seen.has(key)) throw new Error(`Job duplikat ditemukan: ${key}`);
    seen.add(key);
    return validated;
  });
}

async function runImportJobs(
  jobs,
  { refreshCustomers = true, dryRun = false } = {},
) {
  const normalizedJobs = validatedJobs(jobs);
  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, jobs: normalizedJobs }, null, 2));
    return { dry_run: true, jobs: normalizedJobs };
  }

  const refreshedLocations = new Set();
  const results = [];

  for (const [index, job] of normalizedJobs.entries()) {
    const shouldRefreshCustomers =
      refreshCustomers && !refreshedLocations.has(job.source_location_id);
    console.log(
      `\n=== JOB ${index + 1}/${normalizedJobs.length}: ` +
        `${job.location_name} (${job.source_location_id}) ` +
        `${job.start_date} s.d. ${job.end_date} ===`,
    );

    const result = await importSalesTransactions(
      job.source_location_id,
      job.location_name,
      job.start_date,
      job.end_date,
      {
        refreshCustomers: shouldRefreshCustomers,
        expectedTotal: job.expected_total,
      },
    );
    refreshedLocations.add(job.source_location_id);
    results.push(result);
  }

  const summary = {
    complete: results.every((result) => result.complete === true),
    jobs_completed: results.length,
    transactions_received: results.reduce(
      (total, result) => total + result.rows_received,
      0,
    ),
    inserted: results.reduce((total, result) => total + result.inserted, 0),
    updated: results.reduce((total, result) => total + result.updated, 0),
    skipped_zero_points: results.reduce(
      (total, result) => total + result.skipped_zero_points,
      0,
    ),
    deleted_zero_points: results.reduce(
      (total, result) => total + result.deleted_zero_points,
      0,
    ),
    results,
  };
  console.log('\n=== SELURUH JOB IMPORT SELESAI ===');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  await runImportJobs(IMPORT_JOBS, {
    refreshCustomers: !process.argv.includes('--skip-customers'),
    dryRun: process.argv.includes('--dry-run'),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nImport job gagal: ${error.response?.data?.message || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { IMPORT_JOBS, validateJob, validatedJobs, runImportJobs };
