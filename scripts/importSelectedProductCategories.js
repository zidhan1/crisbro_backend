const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const prisma = require('../src/lib/prisma');

const TARGET_BRAND_RUNCHISE_ID = 750;
const EXPECTED_TOTAL = 122;
const PAGE_SIZE = 100;
const WRITE_CHUNK_SIZE = 20;
const MAX_PAGES = 100;
const MAX_DATABASE_MB = 250;
const WRITE_FLAG = '--confirm-db-write';

function optionalText(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function mapCategory(category) {
  const id = positiveInt(category?.id);
  const brandRunchiseId = positiveInt(category?.brand_id);
  const name = optionalText(category?.name);
  const status = optionalText(category?.status)?.toLowerCase();

  if (!id || !brandRunchiseId || !name || !status) {
    throw new Error(`Kategori tidak valid: id=${category?.id ?? 'null'}`);
  }
  if (brandRunchiseId !== TARGET_BRAND_RUNCHISE_ID) {
    throw new Error(`Kategori ${id} memiliki brand_id ${brandRunchiseId}, bukan ${TARGET_BRAND_RUNCHISE_ID}`);
  }

  return {
    id,
    brand_runchise_id: brandRunchiseId,
    name,
    sort_order: Number.isInteger(Number(category.pos_product_layout))
      ? Number(category.pos_product_layout)
      : 0,
    is_active: status === 'activated' && category.deleted !== true,
  };
}

function apiClient() {
  if (!process.env.RUNCHISE_API_KEY) throw new Error('RUNCHISE_API_KEY tidak tersedia');
  return axios.create({
    baseURL: 'https://api.runchise.com/api/public',
    timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
    headers: { Accept: 'application/json', Authorization: process.env.RUNCHISE_API_KEY },
  });
}

async function fetchPageWithRetry(client, page) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { data } = await client.get('/product_categories', {
        params: { brand_id: TARGET_BRAND_RUNCHISE_ID, page, item_per_page: PAGE_SIZE },
      });
      if (!Array.isArray(data?.product_categories)) {
        throw new Error('Response tidak memiliki array product_categories');
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt === 4 || (status && status < 500 && status !== 429)) break;
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function databaseBytes(db) {
  const rows = await db.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  return Number(rows[0]?.bytes ?? 0);
}

async function fetchAndValidate() {
  const client = apiClient();
  const categories = [];
  const seenIds = new Set();
  let reportedTotal = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPageWithRetry(client, page);
    const pageTotal = positiveInt(data.paging?.total_item) ?? 0;
    if (reportedTotal === null) {
      reportedTotal = pageTotal;
      if (reportedTotal !== EXPECTED_TOTAL) {
        throw new Error(`API melaporkan total ${reportedTotal}; expected ${EXPECTED_TOTAL}`);
      }
    } else if (pageTotal !== reportedTotal) {
      throw new Error(`total_item berubah saat pagination: ${reportedTotal} -> ${pageTotal}`);
    }

    for (const rawCategory of data.product_categories) {
      const category = mapCategory(rawCategory);
      if (seenIds.has(category.id)) throw new Error(`ID kategori duplikat: ${category.id}`);
      seenIds.add(category.id);
      categories.push(category);
    }
    console.log(`Halaman ${page}: API=${data.product_categories.length}, total=${categories.length}`);
    if (categories.length >= reportedTotal) break;
    if (data.product_categories.length === 0) break;
  }

  if (categories.length !== reportedTotal) {
    throw new Error(`Pagination tidak lengkap: diterima ${categories.length}/${reportedTotal}`);
  }
  return categories;
}

async function importCategories(categories) {
  const brand = await prisma.brand.findUnique({
    where: { runchise_id: TARGET_BRAND_RUNCHISE_ID },
    select: { id: true, name: true },
  });
  if (!brand) throw new Error(`Brand Runchise ${TARGET_BRAND_RUNCHISE_ID} belum ada di database`);

  const existing = await prisma.menuCategory.findMany({
    where: { id: { in: categories.map((category) => category.id) } },
    select: { id: true, brand_id: true },
  });
  const crossBrandConflict = existing.find((category) => category.brand_id !== brand.id);
  if (crossBrandConflict) {
    throw new Error(`ID kategori ${crossBrandConflict.id} sudah dipakai brand lokal lain`);
  }
  const existingIds = new Set(existing.map((category) => category.id));
  const beforeBytes = await databaseBytes(prisma);
  let processed = 0;

  for (let offset = 0; offset < categories.length; offset += WRITE_CHUNK_SIZE) {
    const currentBytes = await databaseBytes(prisma);
    if (currentBytes >= MAX_DATABASE_MB * 1024 * 1024) {
      throw new Error('Batas ukuran database tercapai sebelum chunk berikutnya');
    }
    const chunk = categories.slice(offset, offset + WRITE_CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((category) =>
        prisma.menuCategory.upsert({
          where: { id: category.id },
          update: {
            name: category.name,
            sort_order: category.sort_order,
            is_active: category.is_active,
          },
          create: {
            id: category.id,
            brand_id: brand.id,
            name: category.name,
            sort_order: category.sort_order,
            is_active: category.is_active,
          },
        }),
      ),
    );
    processed += chunk.length;
    console.log(`Tertulis ${processed}/${categories.length}`);
  }

  const afterBytes = await databaseBytes(prisma);
  return {
    brand_runchise_id: TARGET_BRAND_RUNCHISE_ID,
    brand_local_id: brand.id,
    inserted: categories.filter((category) => !existingIds.has(category.id)).length,
    updated: categories.filter((category) => existingIds.has(category.id)).length,
    database_size_before_bytes: beforeBytes,
    database_size_after_bytes: afterBytes,
    database_growth_bytes: afterBytes - beforeBytes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([WRITE_FLAG, '--dry-run']);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length) throw new Error(`Argumen tidak dikenal: ${unknown.join(', ')}`);
  if (args.includes(WRITE_FLAG) && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }
  const writeEnabled = args.includes(WRITE_FLAG);
  console.log(`Product category import brand=${TARGET_BRAND_RUNCHISE_ID}, mode=${writeEnabled ? 'WRITE' : 'DRY_RUN'}`);
  const categories = await fetchAndValidate();
  const preview = {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    api_rows: categories.length,
    unique_categories: categories.length,
    active: categories.filter((category) => category.is_active).length,
    inactive: categories.filter((category) => !category.is_active).length,
    raw_json_stored: false,
    staging_rows_created: 0,
  };
  const result = writeEnabled ? { ...preview, ...(await importCategories(categories)) } : preview;
  console.log('\n=== HASIL IMPORT ===');
  console.log(JSON.stringify(result, null, 2));
  if (!writeEnabled) console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika hasil benar.`);
}

main()
  .catch((error) => {
    console.error(`\nImport product categories gagal: ${error.response?.data?.message || error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
