const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { setSharedResponseCacheHeaders } = require('../lib/responseCache');
const { respondWithServerError } = require('../lib/serverError');

const {
  CRISBAR_SUB_BRAND_NAME,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../constants/categoryMapping');

const CATALOG_CACHE_TTL_MS = Number(
  process.env.CATALOG_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000,
);
function sendCacheableJson(res, value) {
  setSharedResponseCacheHeaders(res, CATALOG_CACHE_TTL_MS);
  return res.json(value);
}

async function getVisibleCrisbarProducts() {
  return prisma.menuItem.findMany({
    where: {
      is_active: true,
      is_selectable: true,
      category: {
        name: { notIn: Array.from(EXCLUDED_CRISBAR_CATEGORY_NAMES) },
        sub_brand_links: {
          some: {
            sub_brand: {
              name: CRISBAR_SUB_BRAND_NAME,
            },
          },
        },
      },
    },
    include: {
      category: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
  });
}

// GET /api/catalog/products
router.get('/', async (req, res) => {
  try {
    const { category_id } = req.query;
    let items = await getVisibleCrisbarProducts();

    if (category_id) {
      items = items.filter(
        (item) => String(item.category_id) === String(category_id),
      );
    }

    const result = items.map((item) => ({
      id: item.runchise_id ?? item.id,
      name: item.name,
      description: item.description,
      sell_price: Number(item.price),
      image_url: item.image_url,
      category: item.category?.name,
      category_id: item.category_id,
      sku: item.runchise_id ? `RUNCHISE-${item.runchise_id}` : null,
    }));

    sendCacheableJson(res, result);
  } catch (error) {
    respondWithServerError(res, error, 'productCatalogRoutes');
  }
});

// GET /api/catalog/products/categories
router.get('/categories', async (req, res) => {
  try {
    const items = await getVisibleCrisbarProducts();
    const categoryMap = new Map();

    for (const item of items) {
      if (!item.category) continue;

      if (!categoryMap.has(item.category_id)) {
        categoryMap.set(item.category_id, {
          id: item.category_id,
          name: item.category.name,
          total_products: 0,
        });
      }

      categoryMap.get(item.category_id).total_products++;
    }

    const categories = Array.from(categoryMap.values()).sort(
      (a, b) => b.total_products - a.total_products,
    );

    sendCacheableJson(res, categories);
  } catch (error) {
    respondWithServerError(res, error, 'productCatalogRoutes');
  }
});

module.exports = router;
