const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEFAULT_LOCATION_ID = 4453;
const PAGE_SIZE = 100;
const MAX_PAGES = 100000;
const LOCATION_NAMES = new Map([
  [4424, 'Unisba'],
  [4453, 'Antapani'],
  [4561, 'Ujung Berung'],
  [4562, 'Metro Margahayu'],
  [4563, 'Sukapura'],
  [4564, 'Jatinangor'],
  [4565, 'Unjani'],
  [4566, 'Gerlong'],
  [4568, 'Maranatha'],
  [4569, 'Melong'],
  [4571, 'Cihanjuang'],
  [4576, 'UIN Bandung'],
  [4614, 'Widyatama'],
  [4615, 'Sekeloa'],
  [4616, 'Cisitu'],
  [4617, 'Unpar'],
  [4618, 'Taman Kopo Indah'],
  [4619, 'Binus'],
  [4621, 'Kukusan UI'],
  [4622, 'Kelapa Dua'],
  [4623, 'Dramaga'],
  [4706, 'UIN Jakarta'],
  [5339, 'Unpam'],
  [6065, 'Trisakti'],
  [6376, 'Mercubuana'],
  [6897, 'Uhamka'],
  [7279, 'IKPN Bintaro'],
  [9126, 'Unla'],
  [9854, 'Tebet'],
]);

const COLUMNS = [
  'source_location_id', 'runchise_customer_id', 'name', 'phone_number',
  'phone_number_country_code', 'address', 'province', 'city', 'country',
  'postal_code', 'email', 'dob', 'gender', 'brand_id', 'status', 'location_ids',
  'owner_location_id', 'owner_location_name', 'balance', 'total_point',
  'available_point', 'customer_category_id', 'customer_category_name',
  'food_alergy', 'notes', 'customer_code', 'created_by_id', 'last_updated_by_id',
  'runchise_created_at', 'runchise_updated_at', 'last_visited_date', 'raw',
  'last_import_run_id', 'imported_at', 'updated_at',
];

/**
 * Mengubah nilai masukan menjadi bilangan bulat positif. Number(value) membuat
 * angka berbentuk string tetap diterima. Nilai non-integer, nol, atau negatif
 * dianggap tidak valid dan menghasilkan null.
 */
function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Mengubah nilai opsional menjadi bilangan bulat untuk disimpan di database.
 * Nilai null, undefined, string kosong, atau angka yang tidak valid menghasilkan
 * null. Angka nol dan negatif tetap diterima selama berupa integer.
 */
function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Menentukan daftar lokasi efektif customer. location_ids dibersihkan sehingga
 * hanya berisi integer positif yang unik. Jika daftar itu kosong, fungsi memakai
 * owner_location_id sebagai fallback; jika fallback juga tidak valid, hasilnya [].
 */
function effectiveLocationIds(customer) {
  const explicitLocationIds = Array.isArray(customer?.location_ids)
    ? [...new Set(customer.location_ids.map(positiveInt).filter(Boolean))]
    : [];
  if (explicitLocationIds.length > 0) return explicitLocationIds;

  const ownerLocationId = positiveInt(customer?.owner_location_id);
  return ownerLocationId ? [ownerLocationId] : [];
}

/**
 * Menormalkan tanggal dari API ke format ISO. Nilai kosong atau tanggal tidak
 * valid menghasilkan null. Saat dateOnly bernilai true hasilnya YYYY-MM-DD;
 * selain itu fungsi mengembalikan tanggal dan waktu ISO secara lengkap.
 */
function isoDate(value, dateOnly = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();
}

/**
 * Mengubah satu objek customer API menjadi array nilai untuk query INSERT.
 * Posisi nilai harus sama dengan urutan COLUMNS. Fungsi ini juga menormalkan
 * integer/tanggal, membuat JSON, dan menyertakan metadata proses import.
 */
function mapCustomer(customer, sourceLocationId, runId, importedAt) {
  const locationIds = effectiveLocationIds(customer);
  return [
    sourceLocationId,
    Number(customer.id),
    customer.name ?? null,
    customer.phone_number ?? null,
    nullableInt(customer.phone_number_country_code),
    customer.address ?? null,
    customer.province ?? null,
    customer.city ?? null,
    customer.country ?? null,
    customer.postal_code ?? null,
    customer.email ?? null,
    isoDate(customer.dob, true),
    customer.gender ?? null,
    nullableInt(customer.brand_id),
    customer.status ?? null,
    JSON.stringify(locationIds),
    nullableInt(customer.owner_location_id),
    customer.owner_location?.name ?? null,
    customer.balance ?? null,
    nullableInt(customer.total_point),
    nullableInt(customer.available_point),
    nullableInt(customer.customer_category_id),
    customer.customer_category_name ?? null,
    customer.food_alergy ?? null,
    customer.notes ?? null,
    customer.customer_code ?? null,
    nullableInt(customer.created_by_id),
    nullableInt(customer.last_updated_by_id),
    isoDate(customer.created_at),
    isoDate(customer.updated_at),
    isoDate(customer.last_visited_date),
    JSON.stringify(customer),
    runId,
    importedAt,
    importedAt,
  ];
}

/**
 * Mengambil satu halaman customer dari API. Request dicoba maksimal empat kali
 * untuk gangguan jaringan, HTTP 408, 429, dan 5xx. Jeda retry bertambah secara
 * exponential (1, 2, lalu 4 detik); error terakhir diteruskan ke pemanggil.
 */
async function requestPage(client, url, page) {
  let lastError;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return (await client.get(url)).data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = !error.response || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === 3) break;
      const delay = 1000 * 2 ** attempt;
      console.warn(`Halaman ${page} gagal; retry ${attempt + 1}/3 dalam ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Menyimpan satu halaman customer dalam satu query batch. Jika pasangan
 * source_location_id dan runchise_customer_id sudah ada, kolom lain diperbarui.
 * Nilai kembalian memisahkan jumlah data baru dan data yang diperbarui.
 */
async function upsertPage(db, rows) {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const quotedColumns = COLUMNS.map((column) => `"${column}"`).join(', ');
  const updateColumns = COLUMNS.filter(
    (column) => !['source_location_id', 'runchise_customer_id', 'imported_at'].includes(column),
  );
  const assignments = updateColumns
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(', ');

  const result = await db.query(
    `INSERT INTO "RunchiseLocationCustomer" (${quotedColumns})
     VALUES ${tuples.join(', ')}
     ON CONFLICT ("source_location_id", "runchise_customer_id")
     DO UPDATE SET ${assignments}
     RETURNING (xmax = 0) AS inserted`,
    values,
  );

  const inserted = result.rows.filter((row) => row.inserted === true).length;
  return { inserted, updated: result.rowCount - inserted };
}

/**
 * Menghapus data lama milik customer yang sekarang ditolak untuk lokasi sumber.
 * Ini mencegah customer mismatch tetap tercatat sebagai customer lokasi tersebut.
 * Fungsi mengembalikan jumlah baris yang dihapus oleh database.
 */
async function deleteRejectedRows(db, sourceLocationId, customerIds) {
  if (customerIds.length === 0) return 0;
  const result = await db.query(
    `DELETE FROM "RunchiseLocationCustomer"
     WHERE "source_location_id" = $1
       AND "runchise_customer_id" = ANY($2::int[])`,
    [sourceLocationId, customerIds],
  );
  return result.rowCount;
}

/**
 * Menjalankan keseluruhan import untuk satu lokasi: membuat catatan import run,
 * mengambil semua halaman API, memvalidasi customer, menerima data yang lokasi
 * efektifnya memuat locationId, lalu melakukan upsert per halaman dalam transaksi.
 * Data mismatch lama dihapus dan statistik selalu diperbarui. Jika semua halaman
 * selesai status menjadi completed; jika terjadi error status menjadi failed.
 */
async function importLocationCustomers(locationId, locationName) {
  if (!process.env.RUNCHISE_API_KEY) throw new Error('RUNCHISE_API_KEY tidak tersedia');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak tersedia');

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
  let invalid = 0;
  let mismatches = 0;
  let rejected = 0;
  let removed = 0;
  let apiTotal = null;
  const uniqueIds = new Set();

  try {
    const run = await pool.query(
      `INSERT INTO "RunchiseCustomerImportRun"
       ("source_location_id", "source_location_name") VALUES ($1, $2)
       RETURNING "id"`,
      [locationId, locationName],
    );
    runId = run.rows[0].id;

    let nextUrl = `/locations/${locationId}/customers?page=1&item_per_page=${PAGE_SIZE}`;
    const visitedUrls = new Set();

    while (nextUrl !== null) {
      if (pages >= MAX_PAGES) throw new Error(`Melewati batas ${MAX_PAGES} halaman`);
      if (visitedUrls.has(nextUrl)) throw new Error(`Pagination berulang: ${nextUrl}`);
      visitedUrls.add(nextUrl);

      const data = await requestPage(api, nextUrl, pages + 1);
      if (!Array.isArray(data?.customers)) throw new Error('Response tidak memiliki array customers');
      pages++;
      if (apiTotal === null && data.paging?.total_item != null) apiTotal = Number(data.paging.total_item);

      const validCustomers = [];
      const rejectedCustomerIds = [];
      for (const customer of data.customers) {
        const customerId = positiveInt(customer?.id);
        if (!customerId) {
          invalid++;
          continue;
        }
        uniqueIds.add(customerId);
        const locationIds = effectiveLocationIds(customer);
        if (!locationIds.includes(locationId)) {
          mismatches++;
          rejected++;
          rejectedCustomerIds.push(customerId);
          continue;
        }
        validCustomers.push({ ...customer, location_ids: locationIds });
      }

      const importedAt = new Date().toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pageResult = await upsertPage(
          client,
          validCustomers.map((customer) => mapCustomer(customer, locationId, runId, importedAt)),
        );
        removed += await deleteRejectedRows(client, locationId, rejectedCustomerIds);
        inserted += pageResult.inserted;
        updated += pageResult.updated;
        rowsReceived += data.customers.length;
        await client.query(
          `UPDATE "RunchiseCustomerImportRun" SET
             "pages_fetched"=$2, "api_reported_total"=$3, "rows_received"=$4,
             "unique_customers"=$5, "inserted"=$6, "updated"=$7,
             "invalid"=$8, "location_mismatches"=$9
           WHERE "id"=$1`,
          [runId, pages, apiTotal, rowsReceived, uniqueIds.size, inserted, updated, invalid, mismatches],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      console.log(
        `Halaman ${pages}: tersimpan ${validCustomers.length}; ditolak ${rejectedCustomerIds.length}; unik ${uniqueIds.size}`,
      );
      nextUrl = data.paging?.next_page ?? null;
    }

    await pool.query(
      `UPDATE "RunchiseCustomerImportRun"
       SET "status"='completed', "finished_at"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [runId],
    );

    const stored = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "RunchiseLocationCustomer"
       WHERE "source_location_id"=$1`,
      [locationId],
    );
    const result = {
      run_id: String(runId), location_id: locationId, location_name: locationName,
      pages_fetched: pages, rows_received: rowsReceived, unique_customers: uniqueIds.size,
      inserted, updated, invalid, location_mismatches: mismatches,
      rejected_for_location: rejected, removed_stale: removed,
      stored_for_location: stored.rows[0].total, complete: true,
    };
    console.log('\n=== IMPORT SELESAI ===');
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (runId) {
      await pool.query(
        `UPDATE "RunchiseCustomerImportRun"
         SET "status"='failed', "error"=$2, "finished_at"=CURRENT_TIMESTAMP WHERE "id"=$1`,
        [runId, String(error.message).slice(0, 5000)],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Entry point command line. Argumen pertama menjadi location ID (default Antapani
 * 4453), sedangkan argumen kedua menjadi nama lokasi. Jika nama tidak diberikan,
 * nama dicari dari LOCATION_NAMES sebelum proses import dijalankan.
 */
async function main() {
  const locationId = positiveInt(process.argv[2] ?? DEFAULT_LOCATION_ID);
  if (!locationId) throw new Error(`location_id tidak valid: ${process.argv[2]}`);
  const locationName = process.argv[3] || LOCATION_NAMES.get(locationId) || null;
  await importLocationCustomers(locationId, locationName);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nImport gagal: ${error.response?.data?.message || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { effectiveLocationIds, importLocationCustomers };
