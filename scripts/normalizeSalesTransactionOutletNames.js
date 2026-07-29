const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

function parseLocationId(argv) {
  const index = argv.indexOf('--location-id');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('--location-id harus diikuti integer positif');
  }
  return value;
}

async function normalizeOutletNames({ locationId = null, write = false } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak tersedia');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const params = locationId === null ? [] : [locationId];
  const locationFilter = locationId === null
    ? ''
    : 'AND report."source_location_id"=$1 AND location."runchise_id"=$1';

  try {
    const differences = await pool.query(
      `SELECT location."runchise_id" AS location_id,
              location."name" AS canonical_name,
              report."nama_outlet" AS current_name,
              COUNT(*)::int AS transaction_count
       FROM "CustomerSalesTransactionReport" report
       JOIN "Location" location
         ON location."runchise_id"=report."runchise_location_id"
       WHERE report."nama_outlet" IS DISTINCT FROM location."name"
         ${locationFilter}
       GROUP BY location."runchise_id", location."name", report."nama_outlet"
       ORDER BY location."runchise_id", report."nama_outlet"`,
      params,
    );

    if (!write) {
      return { dry_run: true, differences: differences.rows };
    }

    const result = await pool.query(
      `UPDATE "CustomerSalesTransactionReport" report
       SET "nama_outlet"=location."name", "updated_at"=CURRENT_TIMESTAMP
       FROM "Location" location
       WHERE location."runchise_id"=report."runchise_location_id"
         AND report."nama_outlet" IS DISTINCT FROM location."name"
         ${locationFilter}`,
      params,
    );
    return {
      dry_run: false,
      updated: result.rowCount,
      differences: differences.rows,
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const locationId = parseLocationId(process.argv);
  const write = process.argv.includes('--confirm-db-write');
  const result = await normalizeOutletNames({ locationId, write });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Normalisasi nama outlet gagal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { normalizeOutletNames, parseLocationId };
