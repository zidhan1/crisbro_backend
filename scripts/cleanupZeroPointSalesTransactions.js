const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const DEFAULT_BATCH_SIZE = 10000;

function batchSizeFromArgs() {
  const argument = process.argv.find((value) => value.startsWith('--batch-size='));
  const value = Number(argument?.split('=')[1] ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(value) || value <= 0 || value > 50000) {
    throw new Error('--batch-size harus berupa integer antara 1 dan 50000');
  }
  return value;
}

async function cleanupZeroPointSalesTransactions({ confirm = false, batchSize } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak tersedia');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::bigint AS count
       FROM "CustomerSalesTransactionReport"
       WHERE "penambahan_poin"=0 AND "penggunaan_poin"=0`,
    );
    const candidates = Number(countResult.rows[0].count);
    if (!confirm || candidates === 0) {
      return { dry_run: !confirm, candidates, deleted: 0, batch_size: batchSize };
    }

    let deleted = 0;
    while (true) {
      const result = await pool.query(
        `WITH batch AS (
           SELECT "id"
           FROM "CustomerSalesTransactionReport"
           WHERE "penambahan_poin"=0 AND "penggunaan_poin"=0
           ORDER BY "id"
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM "CustomerSalesTransactionReport" report
         USING batch
         WHERE report."id"=batch."id"`,
        [batchSize],
      );
      deleted += result.rowCount;
      console.log(`Terhapus ${deleted}/${candidates} baris nol-nol`);
      if (result.rowCount < batchSize) break;
    }

    return { dry_run: false, candidates, deleted, batch_size: batchSize };
  } finally {
    await pool.end();
  }
}

async function main() {
  const result = await cleanupZeroPointSalesTransactions({
    confirm: process.argv.includes('--confirm-db-write'),
    batchSize: batchSizeFromArgs(),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.dry_run && result.candidates > 0) {
    console.log('Tambahkan --confirm-db-write untuk menjalankan penghapusan.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { batchSizeFromArgs, cleanupZeroPointSalesTransactions };
