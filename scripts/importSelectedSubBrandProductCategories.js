const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');
const { fetchAllSubBrands } = require('../src/services/runchiseService');

const TARGET_PARENT_BRAND_RUNCHISE_ID = 750;
const TARGET_SUB_BRAND_RUNCHISE_ID = 1041;
const WRITE_FLAG = '--confirm-db-write';

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function selectCategoryMapping(apiSubBrands) {
  if (!Array.isArray(apiSubBrands)) {
    throw new Error('Response Runchise tidak memiliki array sub_brands');
  }

  const matches = apiSubBrands.filter(
    (item) => positiveInt(item?.id) === TARGET_SUB_BRAND_RUNCHISE_ID,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Sub-brand Runchise ${TARGET_SUB_BRAND_RUNCHISE_ID} ditemukan ${matches.length} kali`,
    );
  }

  const subBrand = matches[0];
  if (positiveInt(subBrand.brand?.id) !== TARGET_PARENT_BRAND_RUNCHISE_ID) {
    throw new Error(
      `Sub-brand ${TARGET_SUB_BRAND_RUNCHISE_ID} bukan milik parent brand ${TARGET_PARENT_BRAND_RUNCHISE_ID}`,
    );
  }
  if (!Array.isArray(subBrand.product_categories)) {
    throw new Error('Sub-brand Crisbar tidak memiliki array product_categories');
  }

  const categoryById = new Map();
  for (const rawCategory of subBrand.product_categories) {
    const id = positiveInt(rawCategory?.id);
    const name = cleanText(rawCategory?.name);
    if (!id || !name) {
      throw new Error(`Kategori sub-brand tidak valid: id=${rawCategory?.id ?? 'null'}`);
    }
    if (categoryById.has(id)) {
      throw new Error(`Kategori sub-brand duplikat: ${id}`);
    }
    categoryById.set(id, { id, name });
  }

  if (categoryById.size === 0) {
    throw new Error('Mapping kategori Crisbar kosong; rekonsiliasi dibatalkan');
  }

  return {
    parent_brand_runchise_id: TARGET_PARENT_BRAND_RUNCHISE_ID,
    sub_brand_runchise_id: TARGET_SUB_BRAND_RUNCHISE_ID,
    sub_brand_name: cleanText(subBrand.name),
    categories: [...categoryById.values()].sort((left, right) => left.id - right.id),
  };
}

async function inspectDatabase(db, mapping) {
  const subBrand = await db.subBrand.findUnique({
    where: { runchise_id: mapping.sub_brand_runchise_id },
    select: {
      id: true,
      name: true,
      brand: { select: { id: true, runchise_id: true } },
      product_categories: {
        select: { menu_category_id: true },
      },
    },
  });

  if (!subBrand) {
    throw new Error(
      `SubBrand Runchise ${mapping.sub_brand_runchise_id} belum ada di database`,
    );
  }
  if (subBrand.brand.runchise_id !== mapping.parent_brand_runchise_id) {
    throw new Error('Parent brand lokal untuk sub-brand Crisbar tidak sesuai');
  }

  const categoryIds = mapping.categories.map((category) => category.id);
  const localCategories = await db.menuCategory.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, name: true, brand_id: true },
  });
  const localCategoryById = new Map(
    localCategories.map((category) => [category.id, category]),
  );
  const missingCategoryIds = categoryIds.filter((id) => !localCategoryById.has(id));
  if (missingCategoryIds.length > 0) {
    throw new Error(
      `MenuCategory belum lengkap; ID tidak ditemukan: ${missingCategoryIds.join(', ')}`,
    );
  }

  const crossBrandCategory = localCategories.find(
    (category) => category.brand_id !== subBrand.brand.id,
  );
  if (crossBrandCategory) {
    throw new Error(
      `MenuCategory ${crossBrandCategory.id} terhubung ke parent brand lokal lain`,
    );
  }

  const currentIds = new Set(
    subBrand.product_categories.map((link) => link.menu_category_id),
  );
  const sourceIds = new Set(categoryIds);

  return {
    local_sub_brand_id: subBrand.id,
    local_sub_brand_name: subBrand.name,
    source_categories: categoryIds.length,
    existing_links: currentIds.size,
    links_to_insert: categoryIds.filter((id) => !currentIds.has(id)),
    stale_links_to_delete: [...currentIds].filter((id) => !sourceIds.has(id)),
  };
}

async function importCategoryMapping(db, mapping, inspection) {
  const categoryIds = mapping.categories.map((category) => category.id);

  return db.$transaction(async (tx) => {
    const inserted = await tx.subBrandProductCategory.createMany({
      data: categoryIds.map((menuCategoryId) => ({
          sub_brand_id: inspection.local_sub_brand_id,
          menu_category_id: menuCategoryId,
      })),
      skipDuplicates: true,
    });

    const deleted = inspection.stale_links_to_delete.length
      ? await tx.subBrandProductCategory.deleteMany({
          where: {
            sub_brand_id: inspection.local_sub_brand_id,
            menu_category_id: { in: inspection.stale_links_to_delete },
          },
        })
      : { count: 0 };

    const finalCount = await tx.subBrandProductCategory.count({
      where: { sub_brand_id: inspection.local_sub_brand_id },
    });
    if (finalCount !== categoryIds.length) {
      throw new Error(
        `Jumlah relasi setelah import tidak sesuai: ${finalCount}/${categoryIds.length}`,
      );
    }

    return {
      inserted: inserted.count,
      retained: categoryIds.length - inspection.links_to_insert.length,
      deleted_stale: deleted.count,
      final_links: finalCount,
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([WRITE_FLAG, '--dry-run']);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) {
    throw new Error(`Argumen tidak dikenal: ${unknown.join(', ')}`);
  }
  if (args.includes(WRITE_FLAG) && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }

  const writeEnabled = args.includes(WRITE_FLAG);
  console.log(
    `Import mapping kategori sub-brand Crisbar mode=${writeEnabled ? 'WRITE' : 'DRY_RUN'}`,
  );

  const mapping = selectCategoryMapping(await fetchAllSubBrands());
  const inspection = await inspectDatabase(prisma, mapping);
  const preview = {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    ...mapping,
    ...inspection,
  };
  console.log('\n=== RENCANA IMPORT ===');
  console.log(JSON.stringify(preview, null, 2));

  const result = writeEnabled
    ? { ...preview, ...(await importCategoryMapping(prisma, mapping, inspection)) }
    : preview;

  console.log('\n=== HASIL IMPORT ===');
  console.log(JSON.stringify(result, null, 2));
  if (!writeEnabled) {
    console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika hasil benar.`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        `\nImport mapping kategori sub-brand gagal: ${error.response?.data?.message || error.message}`,
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  TARGET_PARENT_BRAND_RUNCHISE_ID,
  TARGET_SUB_BRAND_RUNCHISE_ID,
  importCategoryMapping,
  inspectDatabase,
  selectCategoryMapping,
};
