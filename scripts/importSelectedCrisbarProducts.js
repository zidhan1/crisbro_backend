const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../src/lib/prisma');
const { Prisma } = require('@prisma/client');
const { EXCLUDED_CRISBAR_CATEGORY_NAMES } = require('../src/constants/categoryMapping');
const { fetchProductsPage } = require('../src/services/runchiseService');

const TARGET_PARENT_BRAND_RUNCHISE_ID = 750;
const TARGET_SUB_BRAND_RUNCHISE_ID = 1041;
const PAGE_SIZE = 50;
const WRITE_CHUNK_SIZE = 20;
const MAX_PAGES = 10000;
const WRITE_FLAG = '--confirm-db-write';

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalText(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function mapProduct(product, context) {
  const runchiseId = positiveInt(product?.id);
  const categoryId = positiveInt(product?.product_category?.id);
  const name = optionalText(product?.name);
  const price = Number(product?.sell_price);
  const status = optionalText(product?.status)?.toLowerCase();
  const varianceParentProductId = positiveInt(product?.variance_parent_product_id);

  if (!runchiseId || !categoryId || !name || !Number.isFinite(price) || price < 0 || !status) {
    throw new Error(`Produk Crisbar tidak valid: id=${product?.id ?? 'null'}`);
  }
  if (!context.categoryIds.has(categoryId)) {
    throw new Error(`Produk ${runchiseId} bukan kategori Crisbar`);
  }

  const categoryName = context.categoryNames.get(categoryId);
  const isModifier = product.modifier === true;
  const isSelectable =
    !isModifier &&
    varianceParentProductId === null &&
    !EXCLUDED_CRISBAR_CATEGORY_NAMES.has(categoryName);

  return {
    runchise_id: runchiseId,
    brand_id: context.brandId,
    category_id: categoryId,
    name,
    description: optionalText(product.description),
    price,
    image_url:
      optionalText(product.image_url) || optionalText(product.original_image_url),
    is_active: status === 'activated',
    is_modifier: isModifier,
    is_selectable: isSelectable,
    variance_parent_product_id: varianceParentProductId,
  };
}

async function loadCrisbarContext(db) {
  const subBrand = await db.subBrand.findUnique({
    where: { runchise_id: TARGET_SUB_BRAND_RUNCHISE_ID },
    select: {
      id: true,
      brand: { select: { id: true, runchise_id: true } },
      product_categories: {
        select: {
          menu_category: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!subBrand || subBrand.brand.runchise_id !== TARGET_PARENT_BRAND_RUNCHISE_ID) {
    throw new Error('Mapping parent brand 750 dan sub-brand Crisbar 1041 tidak valid');
  }

  const categoryNames = new Map(
    subBrand.product_categories.map(({ menu_category: category }) => [
      category.id,
      category.name,
    ]),
  );
  if (categoryNames.size === 0) {
    throw new Error('SubBrandProductCategory Crisbar kosong; import dibatalkan');
  }

  const existingProducts = await db.menuItem.findMany({
    where: { category_id: { in: [...categoryNames.keys()] } },
    select: { id: true, runchise_id: true, is_active: true },
  });

  return {
    brandId: subBrand.brand.id,
    categoryIds: new Set(categoryNames.keys()),
    categoryNames,
    existingProducts,
  };
}

async function upsertChunk(db, products) {
  if (products.length === 0) return;

  await db.$transaction(
    products.map((product) =>
      db.$executeRaw(
        Prisma.sql`
          INSERT INTO "MenuItem" (
            "brand_id", "runchise_id", "category_id", "name", "description",
            "price", "image_url", "is_active", "is_modifier", "is_selectable",
            "variance_parent_product_id", "created_at", "updated_at"
          ) VALUES (
            ${product.brand_id}, ${product.runchise_id}, ${product.category_id},
            ${product.name}, ${product.description}, ${product.price},
            ${product.image_url}, ${product.is_active}, ${product.is_modifier},
            ${product.is_selectable}, ${product.variance_parent_product_id},
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("runchise_id") DO UPDATE SET
            "brand_id" = EXCLUDED."brand_id",
            "category_id" = EXCLUDED."category_id",
            "name" = EXCLUDED."name",
            "description" = EXCLUDED."description",
            "price" = EXCLUDED."price",
            "image_url" = EXCLUDED."image_url",
            "is_active" = EXCLUDED."is_active",
            "is_modifier" = EXCLUDED."is_modifier",
            "is_selectable" = EXCLUDED."is_selectable",
            "variance_parent_product_id" = EXCLUDED."variance_parent_product_id",
            "updated_at" = CURRENT_TIMESTAMP
        `,
      ),
    ),
  );
}

async function importProducts({ db = prisma, writeEnabled = false } = {}) {
  const context = await loadCrisbarContext(db);
  const existingByRunchiseId = new Map(
    context.existingProducts
      .filter((product) => product.runchise_id !== null)
      .map((product) => [product.runchise_id, product]),
  );
  const seenCrisbarIds = new Set();
  const metrics = {
    mode: writeEnabled ? 'WRITE' : 'DRY_RUN',
    parent_brand_runchise_id: TARGET_PARENT_BRAND_RUNCHISE_ID,
    sub_brand_runchise_id: TARGET_SUB_BRAND_RUNCHISE_ID,
    crisbar_categories: context.categoryIds.size,
    pages_processed: 0,
    api_products_scanned: 0,
    crisbar_products_matched: 0,
    active: 0,
    inactive: 0,
    selectable: 0,
    non_selectable: 0,
    inserted: 0,
    updated: 0,
    deactivated_stale: 0,
  };
  let reportedTotal = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchProductsPage({ page, itemPerPage: PAGE_SIZE });
    const pageReportedTotal = Number(data.paging.total_item);
    if (Number.isFinite(pageReportedTotal)) {
      if (reportedTotal === null) reportedTotal = pageReportedTotal;
      if (reportedTotal !== pageReportedTotal) {
        throw new Error(`total_item berubah saat pagination: ${reportedTotal} -> ${pageReportedTotal}`);
      }
    }

    const mappedProducts = [];
    for (const rawProduct of data.products) {
      metrics.api_products_scanned++;
      const categoryId = positiveInt(rawProduct?.product_category?.id);
      if (!categoryId || !context.categoryIds.has(categoryId)) continue;

      const product = mapProduct(rawProduct, context);
      if (seenCrisbarIds.has(product.runchise_id)) {
        throw new Error(`Produk Crisbar duplikat antar halaman: ${product.runchise_id}`);
      }
      seenCrisbarIds.add(product.runchise_id);
      mappedProducts.push(product);

      metrics.crisbar_products_matched++;
      metrics[product.is_active ? 'active' : 'inactive']++;
      metrics[product.is_selectable ? 'selectable' : 'non_selectable']++;
      metrics[existingByRunchiseId.has(product.runchise_id) ? 'updated' : 'inserted']++;
    }

    if (writeEnabled) {
      for (let offset = 0; offset < mappedProducts.length; offset += WRITE_CHUNK_SIZE) {
        await upsertChunk(db, mappedProducts.slice(offset, offset + WRITE_CHUNK_SIZE));
      }
    }

    metrics.pages_processed++;
    console.log(
      `Halaman ${page}: API=${data.products.length}, Crisbar=${mappedProducts.length}, total Crisbar=${metrics.crisbar_products_matched}`,
    );

    if (data.paging.next_page === null || data.products.length === 0) break;
    if (page === MAX_PAGES) throw new Error(`Pagination melebihi ${MAX_PAGES} halaman`);
  }

  if (metrics.crisbar_products_matched === 0) {
    throw new Error('API tidak menghasilkan produk Crisbar; soft-deactivation dibatalkan');
  }
  if (reportedTotal !== null && metrics.api_products_scanned !== reportedTotal) {
    throw new Error(
      `Pagination tidak lengkap: dipindai ${metrics.api_products_scanned}/${reportedTotal}`,
    );
  }

  const staleLocalIds = context.existingProducts
    .filter(
      (product) =>
        product.is_active &&
        product.runchise_id !== null &&
        !seenCrisbarIds.has(product.runchise_id),
    )
    .map((product) => product.id);
  metrics.deactivated_stale = staleLocalIds.length;

  if (writeEnabled && staleLocalIds.length > 0) {
    await db.menuItem.updateMany({
      where: { id: { in: staleLocalIds } },
      data: { is_active: false },
    });
  }

  return metrics;
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([WRITE_FLAG, '--dry-run']);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) throw new Error(`Argumen tidak dikenal: ${unknown.join(', ')}`);
  if (args.includes(WRITE_FLAG) && args.includes('--dry-run')) {
    throw new Error(`${WRITE_FLAG} tidak boleh digabung dengan --dry-run`);
  }

  const writeEnabled = args.includes(WRITE_FLAG);
  console.log(`Import produk Crisbar mode=${writeEnabled ? 'WRITE' : 'DRY_RUN'}`);
  const result = await importProducts({ writeEnabled });
  console.log('\n=== HASIL IMPORT PRODUK CRISBAR ===');
  console.log(JSON.stringify(result, null, 2));
  if (!writeEnabled) {
    console.log(`\nDRY-RUN selesai. Tambahkan ${WRITE_FLAG} jika hasil benar.`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        `\nImport produk Crisbar gagal: ${error.response?.data?.message || error.message}`,
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  importProducts,
  loadCrisbarContext,
  mapProduct,
};
