const express = require('express');
const router = express.Router();
const { fetchAllProducts } = require('../services/runchiseService');
const { CATEGORY_MAPPING } = require('../constants/categoryMapping');

// GET /api/catalog/products
router.get('/', async (req, res) => {
  try {
    const { category_id } = req.query;

    const products = await fetchAllProducts();

    let filtered = products.filter((p) => p.status === 'activated');

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
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const products = await fetchAllProducts();

    const categoryMap = new Map();

    products.forEach((p) => {
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
    res.status(500).json({
      error: error.message,
    });
  }
});
module.exports = router;
