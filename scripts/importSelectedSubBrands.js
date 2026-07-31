const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');
const { fetchAllSubBrands } = require('../src/services/runchiseService');

const DEFAULT_SELECTED_IDS = Object.freeze([1041, 1081, 1104, 2749]);
const WRITE_FLAG = '--confirm-db-write';

function printHelp() {
  console.log(`
Import Brand/SubBrand Runchise secara selektif.

Penggunaan:
  npm run import:selected-sub-brands
  npm run import:selected-sub-brands -- --confirm-db-write
  npm run import:selected-sub-brands -- --ids=1041,2749

Perilaku aman:
  - Default adalah dry-run; database tidak ditulis.
  - Penulisan hanya dilakukan dengan ${WRITE_FLAG}.
  - Hanya data scalar Brand/SubBrand yang disimpan.
  - Locations, product categories, products, exclusions, dan raw JSON diabaikan.
`);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSelectedIds(args) {
  const idsArgument = args.find((argument) => argument.startsWith('--ids='));
  if (!idsArgument) return [...DEFAULT_SELECTED_IDS];

  const values = idsArgument.slice('--ids='.length).split(',');
  const ids = [...new Set(values.map((value) => positiveInt(value.trim())))];
  if (ids.length === 0 || ids.includes(null)) {
    throw new Error('--ids harus berisi ID positif dipisahkan koma');
  }
  return ids.sort((left, right) => left - right);
}

function cleanOptionalText(value) {
  const cleaned = String(value ?? '').trim();
  return cleaned || null;
}

function selectSubBrands(apiSubBrands, selectedIds) {
  if (!Array.isArray(apiSubBrands)) {
    throw new Error('Response Runchise tidak memiliki array sub_brands');
  }

  const selectedIdSet = new Set(selectedIds);
  const byId = new Map();

  for (const item of apiSubBrands) {
    const runchiseId = positiveInt(item?.id);
    if (!runchiseId || !selectedIdSet.has(runchiseId)) continue;
    if (byId.has(runchiseId)) {
      throw new Error(`Sub-brand Runchise duplikat: ${runchiseId}`);
    }

    const name = cleanOptionalText(item.name);
    const brandRunchiseId = positiveInt(item.brand?.id);
    const brandName = cleanOptionalText(item.brand?.name);
    if (!name || !brandRunchiseId || !brandName) {
      throw new Error(`Sub-brand ${runchiseId} tidak memiliki nama/parent brand valid`);
    }

    byId.set(runchiseId, {
      runchise_id: runchiseId,
      name,
      image_url: cleanOptionalText(item.image_url),
      location_type: cleanOptionalText(item.location_type),
      is_select_all_location: item.is_select_all_location === true,
      enable_online_order: item.enable_online_order !== false,
      brand: {
        runchise_id: brandRunchiseId,
        name: brandName,
      },
    });
  }

  const missingIds = selectedIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Sub-brand pilihan tidak ditemukan di API: ${missingIds.join(', ')}`);
  }

  return [...byId.values()].sort((left, right) => left.runchise_id - right.runchise_id);
}

function buildPreview(selectedSubBrands, writeEnabled) {
  const brands = new Map();
  for (const subBrand of selectedSubBrands) {
    const existing = brands.get(subBrand.brand.runchise_id);
    if (existing && existing.name !== subBrand.brand.name) {
      throw new Error(`Nama parent brand ${subBrand.brand.runchise_id} tidak konsisten`);
    }
    brands.set(subBrand.brand.runchise_id, subBrand.brand);
  }

  return {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    brands: [...brands.values()],
    sub_brands: selectedSubBrands.map(({ brand, ...subBrand }) => ({
      ...subBrand,
      brand_runchise_id: brand.runchise_id,
    })),
    deliberately_skipped: [
      'locations',
      'product_categories',
      'exclude_locations',
      'exclude_products',
      'products',
      'raw_json',
    ],
  };
}

async function databaseBytes(db) {
  const rows = await db.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  return Number(rows[0]?.bytes ?? 0);
}

async function importSelectedSubBrands(selectedSubBrands) {
  const beforeBytes = await databaseBytes(prisma);
  const result = await prisma.$transaction(async (tx) => {
    const existingSubBrands = await tx.subBrand.findMany({
      where: { runchise_id: { in: selectedSubBrands.map((item) => item.runchise_id) } },
      select: { runchise_id: true },
    });
    const existingIds = new Set(existingSubBrands.map((item) => item.runchise_id));
    const localBrandByRunchiseId = new Map();

    for (const item of selectedSubBrands) {
      if (localBrandByRunchiseId.has(item.brand.runchise_id)) continue;
      const brand = await tx.brand.upsert({
        where: { runchise_id: item.brand.runchise_id },
        update: { name: item.brand.name },
        create: {
          runchise_id: item.brand.runchise_id,
          name: item.brand.name,
        },
      });
      localBrandByRunchiseId.set(item.brand.runchise_id, brand.id);
    }

    for (const item of selectedSubBrands) {
      const data = {
        brand_id: localBrandByRunchiseId.get(item.brand.runchise_id),
        name: item.name,
        image_url: item.image_url,
        location_type: item.location_type,
        is_select_all_location: item.is_select_all_location,
        enable_online_order: item.enable_online_order,
      };
      await tx.subBrand.upsert({
        where: { runchise_id: item.runchise_id },
        update: data,
        create: { runchise_id: item.runchise_id, ...data },
      });
    }

    return {
      brands_upserted: localBrandByRunchiseId.size,
      sub_brands_inserted: selectedSubBrands.filter(
        (item) => !existingIds.has(item.runchise_id),
      ).length,
      sub_brands_updated: selectedSubBrands.filter(
        (item) => existingIds.has(item.runchise_id),
      ).length,
    };
  });
  const afterBytes = await databaseBytes(prisma);

  return {
    ...result,
    database_size_before_bytes: beforeBytes,
    database_size_after_bytes: afterBytes,
    database_growth_bytes: afterBytes - beforeBytes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const unknownArguments = args.filter(
    (argument) =>
      argument !== WRITE_FLAG &&
      argument !== '--dry-run' &&
      !argument.startsWith('--ids='),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Argumen tidak dikenal: ${unknownArguments.join(', ')}`);
  }

  const writeEnabled = args.includes(WRITE_FLAG);
  if (writeEnabled && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }

  const selectedIds = parseSelectedIds(args);
  console.log(`Mengambil sub-brand Runchise; allowlist ID: ${selectedIds.join(', ')}`);
  const apiSubBrands = await fetchAllSubBrands();
  const selectedSubBrands = selectSubBrands(apiSubBrands, selectedIds);
  const preview = buildPreview(selectedSubBrands, writeEnabled);
  console.log('\n=== RENCANA IMPORT ===');
  console.log(JSON.stringify(preview, null, 2));

  if (!writeEnabled) {
    console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika data di atas sudah benar.`);
    return preview;
  }

  const result = await importSelectedSubBrands(selectedSubBrands);
  console.log('\n=== IMPORT SELESAI ===');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`\nImport sub-brand gagal: ${error.response?.data?.message || error.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  DEFAULT_SELECTED_IDS,
  buildPreview,
  importSelectedSubBrands,
  parseSelectedIds,
  selectSubBrands,
};
