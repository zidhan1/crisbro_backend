const express = require('express');
const router = express.Router();
const { fetchAllProducts } = require('../services/runchiseService');
const { getCategoryIdsForSubBrand } = require('../services/subBrandService');
const {
  CRISBAR_SUB_BRAND_NAME,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../constants/categoryMapping');

async function getVisibleCrisbarProducts() {
  const [products, crisbarCategoryIds] = await Promise.all([
    fetchAllProducts(),
    getCategoryIdsForSubBrand(CRISBAR_SUB_BRAND_NAME),
  ]);

  if (crisbarCategoryIds.size === 0) {
    console.warn(
      `Tidak menemukan kategori untuk sub-brand "${CRISBAR_SUB_BRAND_NAME}" dari Runchise. ` +
        'Cek nama sub-brand di API atau ketersediaan endpoint /sub_brands.',
    );
  }

  return products.filter((p) => {
    if (p.status !== 'activated') return false;

    const category = p.product_category;
    if (!category || category.id == null) return false;

    if (!crisbarCategoryIds.has(category.id)) return false;
    if (EXCLUDED_CRISBAR_CATEGORY_NAMES.has(category.name)) return false;

    return true;
  });
}

// GET /api/catalog/products
router.get('/', async (req, res) => {
  try {
    const { category_id } = req.query;

    let filtered = await getVisibleCrisbarProducts();

    if (category_id) {
      filtered = filtered.filter(
        (p) => String(p.product_category?.id) === String(category_id),
      );
    }

    const result = filtered.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      sell_price: Number(p.sell_price),
      image_url: p.image_url,
      category: p.product_category?.name,
      category_id: p.product_category?.id,
      sku: p.sku ?? null,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/catalog/products/categories
router.get('/categories', async (req, res) => {
  try {
    const filtered = await getVisibleCrisbarProducts();

    const categoryMap = new Map();

    filtered.forEach((p) => {
      const category = p.product_category;
      if (!category) return;

      if (!categoryMap.has(category.id)) {
        categoryMap.set(category.id, {
          id: category.id,
          name: category.name,
          total_products: 0,
        });
      }

      categoryMap.get(category.id).total_products++;
    });

    const categories = Array.from(categoryMap.values()).sort(
      (a, b) => b.total_products - a.total_products,
    );

    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;