const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');
const { importLocationCustomers } = require('./importRunchiseLocationCustomers');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const DEFAULT_LOCATION_ID = 4453;
const DEFAULT_START_DATE = '2024-01-01';
const DEFAULT_END_DATE = '2024-08-31';
const PAGE_SIZE = 100;
const MAX_PAGES = 100000;

const COLUMNS = [
  'source_location_id', 'runchise_sales_transaction_id', 'runchise_customer_id',
  'customer_id', 'runchise_location_id', 'nama_pelanggan', 'no_telepon',
  'lokasi_dibuat', 'pelanggan_sejak', 'poin_pelanggan', 'tanggal_transaksi',
  'nama_outlet', 'tipe_order', 'pembelian_per_order', 'penambahan_poin',
  'penggunaan_poin', 'sales_no', 'receipt_no', 'status', 'is_deleted',
  'nominal_transaksi', 'jumlah_diterima', 'jumlah_kembalian', 'sumber_nominal',
  'payment_methods', 'customer_snapshot_at', 'import_run_id', 'raw',
  'created_at', 'updated_at',
];

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = 0) {
  return Math.trunc(number(value, fallback));
}

function isoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validateDateOnly(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${label} harus memakai format YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} tidak valid: ${value}`);
  }
  return value;
}

function jakartaRange(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000+07:00`);
  const endExclusive = new Date(`${endDate}T00:00:00.000+07:00`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  if (start >= endExclusive) throw new Error('start_date harus sebelum atau sama dengan end_date');
  return { start, endExclusive };
}

function formatPhone(phone, countryCode = 62) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  const code = String(countryCode || 62).replace(/\D/g, '') || '62';
  if (digits.startsWith(code)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${code}${digits.slice(1)}`;
  return `+${code}${digits}`;
}

function payments(sale) {
  return Array.isArray(sale.payments) ? sale.payments : [];
}

function transactionNominal(sale) {
  const candidates = [
    ['net_sales_after_tax', sale.net_sales_after_tax],
    ['net_sales', sale.net_sales],
    ['new_net_sales', sale.new_net_sales],
    ['subtotal', sale.subtotal],
    ['gross_sales', sale.gross_sales],
  ];
  const found = candidates.find(([, value]) => value !== null && value !== undefined && value !== '');
  return found ? { value: number(found[1]), source: found[0] } : { value: 0, source: 'none' };
}

function mapSale(
  sale,
  sourceLocationId,
  customer,
  localCustomerId,
  canonicalOutletName,
  runId,
  snapshotAt,
) {
  const salePayments = payments(sale);
  const amountReceived = salePayments.reduce((total, item) => total + number(item.amount_receive), 0);
  const change = salePayments.reduce((total, item) => total + number(item.change), 0);
  const nominal = transactionNominal(sale);
  const metadata = sale.metadata || {};
  const transactionAt = isoDate(sale.sales_time ?? sale.sales_time_date ?? sale.created_at);
  const paymentMethods =
    sale.payment_method_names ??
    ([...new Set(salePayments.map((item) => item.payment_method_name).filter(Boolean))].join(', ') || null);

  return [
    sourceLocationId,
    Number(sale.id),
    positiveInt(sale.customer_id),
    localCustomerId ?? null,
    positiveInt(sale.location_id),
    sale.customer_name ?? customer?.name ?? null,
    formatPhone(
      sale.customer_phone_number ?? customer?.phone_number,
      sale.customer_phone_number_country_code ?? customer?.phone_number_country_code,
    ),
    customer?.owner_location_name ?? null,
    customer?.runchise_created_at ? isoDate(customer.runchise_created_at) : null,
    integer(customer?.available_point ?? metadata.available_point ?? metadata.total_point),
    transactionAt,
    canonicalOutletName ?? sale.location_name ?? sale.location?.name ?? null,
    sale.order_type_name ?? null,
    salePayments.length > 0 ? amountReceived : nominal.value,
    integer(metadata.earned_point),
    number(metadata.redeemed_point),
    sale.sales_no ?? null,
    sale.receipt_no ?? null,
    sale.status ?? null,
    Boolean(sale.deleted),
    nominal.value,
    amountReceived,
    change,
    salePayments.length > 0 ? 'payments.amount_receive' : nominal.source,
    paymentMethods,
    snapshotAt,
    runId,
    JSON.stringify(sale),
    snapshotAt,
    snapshotAt,
  ];
}

async function requestPage(api, url, page) {
  let lastError;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return (await api.get(url)).data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = !error.response || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || attempt === 3) break;
      const delay = 1000 * 2 ** attempt;
      console.warn(`Halaman transaksi ${page} gagal; retry ${attempt + 1}/3 dalam ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function extractTransactions(data) {
  if (Array.isArray(data)) return data;
  return data?.sale_transactions ?? data?.sales_transactions ?? data?.transactions ?? data?.data ?? null;
}

function nextPageUrl(data, currentPage, receivedCount, pageLength, initialParams) {
  if (data?.paging?.next_page !== undefined) return data.paging.next_page;
  const total = Number(data?.paging?.total_item);
  if (Number.isFinite(total)) {
    if (receivedCount >= total) return null;
  } else if (pageLength < PAGE_SIZE) {
    return null;
  }
  const params = new URLSearchParams(initialParams);
  params.set('page', String(currentPage + 1));
  return `/sale_transactions?${params.toString()}`;
}

async function loadCustomerMaps(db, sourceLocationId) {
  const [staged, local, locations] = await Promise.all([
    db.query(
      `SELECT "runchise_customer_id", "name", "phone_number",
              "phone_number_country_code", "owner_location_name",
              "runchise_created_at", "available_point"
       FROM "RunchiseLocationCustomer" WHERE "source_location_id"=$1`,
      [sourceLocationId],
    ),
    db.query(`SELECT "id", "runchise_id" FROM "Customer" WHERE "runchise_id" IS NOT NULL`),
    db.query(
      `SELECT "runchise_id", "name" FROM "Location"
       WHERE "runchise_id" IS NOT NULL`,
    ),
  ]);
  return {
    staged: new Map(staged.rows.map((row) => [Number(row.runchise_customer_id), row])),
    local: new Map(local.rows.map((row) => [Number(row.runchise_id), Number(row.id)])),
    locations: new Map(
      locations.rows.map((row) => [Number(row.runchise_id), row.name]),
    ),
  };
}

async function upsertPage(db, rows, zeroPointSaleIds, sourceLocationId) {
  let deletedZeroPoints = 0;
  if (zeroPointSaleIds.length > 0) {
    const deleted = await db.query(
      `DELETE FROM "CustomerSalesTransactionReport"
       WHERE "source_location_id"=$1
         AND "runchise_sales_transaction_id"=ANY($2::int[])
       RETURNING "id"`,
      [sourceLocationId, zeroPointSaleIds],
    );
    deletedZeroPoints = deleted.rowCount;
  }
  if (rows.length === 0) {
    return { inserted: 0, updated: 0, deletedZeroPoints };
  }
  const values = [];
  const tuples = rows.map((row) => `(${row.map((value) => {
    values.push(value);
    return `$${values.length}`;
  }).join(', ')})`);
  const quotedColumns = COLUMNS.map((column) => `"${column}"`).join(', ');
  const updateColumns = COLUMNS.filter((column) => ![
    'source_location_id', 'runchise_sales_transaction_id', 'created_at',
  ].includes(column));
  const assignments = updateColumns.map((column) => `"${column}"=EXCLUDED."${column}"`).join(', ');
  const result = await db.query(
    `INSERT INTO "CustomerSalesTransactionReport" (${quotedColumns})
     VALUES ${tuples.join(', ')}
     ON CONFLICT ("source_location_id", "runchise_sales_transaction_id")
     DO UPDATE SET ${assignments}
     RETURNING (xmax = 0) AS inserted`,
    values,
  );
  const inserted = result.rows.filter((row) => row.inserted === true).length;
  return { inserted, updated: result.rowCount - inserted, deletedZeroPoints };
}

async function importSalesTransactions(
  locationId,
  locationName,
  startDate,
  endDate,
  { refreshCustomers = true, expectedTotal = null } = {},
) {
  if (!process.env.RUNCHISE_API_KEY) throw new Error('RUNCHISE_API_KEY tidak tersedia');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak tersedia');
  validateDateOnly(startDate, 'start_date');
  validateDateOnly(endDate, 'end_date');
  const range = jakartaRange(startDate, endDate);

  const customerImport = refreshCustomers
    ? await (async () => {
        console.log('Memperbarui snapshot customer untuk lokasi sumber...');
        return importLocationCustomers(locationId, locationName);
      })()
    : { skipped: true, reason: 'snapshot customer sudah diperbarui pada run sebelumnya' };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = axios.create({
    baseURL: 'https://api.runchise.com/api/public',
    timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
    headers: { Accept: 'application/json', Authorization: process.env.RUNCHISE_API_KEY },
  });

  let runId;
  let pages = 0;
  let rowsReceived = 0;
  let inserted = 0;
  let updated = 0;
  let skippedZeroPoints = 0;
  let deletedZeroPoints = 0;
  let invalid = 0;
  let locationMismatches = 0;
  let outOfRange = 0;
  let apiTotal = 0;
  const uniqueIds = new Set();
  const retainedIds = new Set();

  try {
    const run = await pool.query(
      `INSERT INTO "RunchiseSalesTransactionImportRun"
       ("source_location_id", "source_location_name", "start_date", "end_date")
       VALUES ($1, $2, $3::date, $4::date) RETURNING "id"`,
      [locationId, locationName, startDate, endDate],
    );
    runId = run.rows[0].id;
    const customerMaps = await loadCustomerMaps(pool, locationId);
    const snapshotAt = new Date().toISOString();
    const visitedUrls = new Set();
    const cursor = new Date(`${startDate}T00:00:00.000Z`);
    const finalDay = new Date(`${endDate}T00:00:00.000Z`);

    // Endpoint membatasi hasil sebuah rentang hingga 500 record. Window harian
    // mencegah transaksi awal periode hilang walaupun semua halaman rentang besar
    // sudah diambil.
    while (cursor <= finalDay) {
      const windowDate = cursor.toISOString().slice(0, 10);
      const initialParams = {
        page: '1', item_per_page: String(PAGE_SIZE), location_id: String(locationId),
        start_date: windowDate, end_date: windowDate,
      };
      let nextUrl = `/sale_transactions?${new URLSearchParams(initialParams).toString()}`;
      let windowPage = 0;
      let windowRowsReceived = 0;
      let windowApiTotal = null;

      while (nextUrl !== null) {
        if (pages >= MAX_PAGES) throw new Error(`Melewati batas ${MAX_PAGES} halaman`);
        if (visitedUrls.has(nextUrl)) throw new Error(`Pagination berulang: ${nextUrl}`);
        visitedUrls.add(nextUrl);
        const data = await requestPage(api, nextUrl, pages + 1);
        const transactions = extractTransactions(data);
        if (!Array.isArray(transactions)) throw new Error('Response tidak memiliki array sale_transactions');
        pages++;
        windowPage++;
        rowsReceived += transactions.length;
        windowRowsReceived += transactions.length;
        if (windowApiTotal === null && data?.paging?.total_item != null) {
          windowApiTotal = Number(data.paging.total_item);
          apiTotal += windowApiTotal;
        }

        const rows = [];
        const zeroPointSaleIds = [];
        for (const sale of transactions) {
        const saleId = positiveInt(sale?.id);
        if (!saleId || uniqueIds.has(saleId)) {
          invalid++;
          continue;
        }
        uniqueIds.add(saleId);
        if (positiveInt(sale.location_id) !== locationId) {
          locationMismatches++;
          continue;
        }
        const transactionAt = new Date(sale.sales_time ?? sale.sales_time_date ?? sale.created_at);
        if (Number.isNaN(transactionAt.getTime())) {
          invalid++;
          continue;
        }
        if (transactionAt < range.start || transactionAt >= range.endExclusive) {
          outOfRange++;
          continue;
        }
        const customerId = positiveInt(sale.customer_id);
        const row = mapSale(
          sale, locationId, customerMaps.staged.get(customerId),
          customerMaps.local.get(customerId),
          customerMaps.locations.get(positiveInt(sale.location_id)),
          runId, snapshotAt,
        );
        // Indeks 14 dan 15 mengikuti COLUMNS: penambahan_poin dan
        // penggunaan_poin. Salah satu nilai non-nol cukup untuk menyimpan baris.
        if (number(row[14]) === 0 && number(row[15]) === 0) {
          zeroPointSaleIds.push(saleId);
          skippedZeroPoints++;
        } else {
          rows.push(row);
          retainedIds.add(saleId);
        }
        }

        const client = await pool.connect();
        try {
        await client.query('BEGIN');
        const result = await upsertPage(
          client,
          rows,
          zeroPointSaleIds,
          locationId,
        );
        inserted += result.inserted;
        updated += result.updated;
        deletedZeroPoints += result.deletedZeroPoints;
        await client.query(
          `UPDATE "RunchiseSalesTransactionImportRun" SET
             "pages_fetched"=$2, "api_reported_total"=$3, "rows_received"=$4,
             "unique_transactions"=$5, "inserted"=$6, "updated"=$7,
             "invalid"=$8, "location_mismatches"=$9, "out_of_range"=$10,
             "last_page"=$2 WHERE "id"=$1`,
          [runId, pages, apiTotal, rowsReceived, uniqueIds.size, inserted, updated,
            invalid, locationMismatches, outOfRange],
        );
        await client.query('COMMIT');
        } catch (error) {
        await client.query('ROLLBACK');
        throw error;
        } finally {
        client.release();
        }
        console.log(`${windowDate} halaman ${windowPage}: diterima ${transactions.length}; disimpan ${rows.length}; nol-nol ${zeroPointSaleIds.length}; unik ${uniqueIds.size}`);
        nextUrl = nextPageUrl(
          data, windowPage, windowRowsReceived, transactions.length, initialParams,
        );
      }

      if (windowApiTotal !== null && windowRowsReceived !== windowApiTotal) {
        throw new Error(
          `Jumlah ${windowDate} tidak lengkap: API=${windowApiTotal}, diterima=${windowRowsReceived}`,
        );
      }
      // Nilai total yang lebih besar dari 500 bukan truncation: pagination
      // harian dapat mengembalikan seluruh baris (misalnya 527). Hanya total
      // tepat 500 yang tetap ambigu terhadap batas historis endpoint.
      if (windowApiTotal === 500) {
        throw new Error(
          `Tanggal ${windowDate} mencapai batas 500 record API; window yang lebih kecil diperlukan`,
        );
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const verification = await pool.query(
      `SELECT COUNT(*)::int AS stored,
              COUNT(DISTINCT "runchise_sales_transaction_id")::int AS unique_stored,
              MIN("tanggal_transaksi") AS min_date, MAX("tanggal_transaksi") AS max_date,
              COUNT(*) FILTER (WHERE "source_location_id"<>$1)::int AS wrong_source,
              COUNT(*) FILTER (WHERE "runchise_location_id"<>$1)::int AS wrong_location
       FROM "CustomerSalesTransactionReport"
       WHERE "source_location_id"=$1
         AND "tanggal_transaksi">=$2::date - INTERVAL '7 hours'
         AND "tanggal_transaksi"<$3::date + INTERVAL '1 day' - INTERVAL '7 hours'`,
      [locationId, startDate, endDate],
    );
    const verificationResult = verification.rows[0];
    const mismatchReasons = [];
    if (expectedTotal !== null && apiTotal !== expectedTotal) {
      mismatchReasons.push(`expected_total=${expectedTotal}, api=${apiTotal}`);
    }
    if (rowsReceived !== apiTotal) {
      mismatchReasons.push(`api=${apiTotal}, diterima=${rowsReceived}`);
    }
    if (retainedIds.size !== Number(verificationResult.unique_stored)) {
      mismatchReasons.push(
        `unik_berpoin=${retainedIds.size}, unik_database=${verificationResult.unique_stored}`,
      );
    }
    if (invalid > 0 || locationMismatches > 0 || outOfRange > 0) {
      mismatchReasons.push(
        `invalid=${invalid}, mismatch_lokasi=${locationMismatches}, di_luar_periode=${outOfRange}`,
      );
    }
    const status = mismatchReasons.length === 0
      ? 'completed'
      : 'completed_with_mismatch';
    await pool.query(
      `UPDATE "RunchiseSalesTransactionImportRun"
       SET "status"=$2, "error"=$3, "finished_at"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [runId, status, mismatchReasons.length > 0 ? mismatchReasons.join('; ') : null],
    );
    const result = {
      run_id: String(runId), location_id: locationId, location_name: locationName,
      start_date: startDate, end_date: endDate, pages_fetched: pages,
      api_reported_total: apiTotal, rows_received: rowsReceived,
      unique_transactions: uniqueIds.size, inserted, updated, invalid,
      skipped_zero_points: skippedZeroPoints,
      deleted_zero_points: deletedZeroPoints,
      location_mismatches: locationMismatches, out_of_range: outOfRange,
      expected_total: expectedTotal, status, mismatch_reasons: mismatchReasons,
      customer_import: customerImport, verification: verificationResult,
      complete: status === 'completed',
    };
    console.log('\n=== IMPORT TRANSAKSI SELESAI ===');
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (runId) {
      await pool.query(
        `UPDATE "RunchiseSalesTransactionImportRun"
         SET "status"='failed', "error"=$2, "finished_at"=CURRENT_TIMESTAMP WHERE "id"=$1`,
        [runId, String(error.response?.data?.message || error.message).slice(0, 5000)],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function main() {
  const locationId = positiveInt(process.argv[2] ?? DEFAULT_LOCATION_ID);
  if (!locationId) throw new Error(`location_id tidak valid: ${process.argv[2]}`);
  const startDate = process.argv[3] ?? DEFAULT_START_DATE;
  const endDate = process.argv[4] ?? DEFAULT_END_DATE;
  const locationName = process.argv[5] ?? (locationId === 4453 ? 'Antapani' : null);
  await importSalesTransactions(locationId, locationName, startDate, endDate, {
    refreshCustomers: !process.argv.includes('--skip-customers'),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nImport transaksi gagal: ${error.response?.data?.message || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  formatPhone, jakartaRange, mapSale, transactionNominal, importSalesTransactions,
};
