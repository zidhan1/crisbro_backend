const express = require('express');
const router = express.Router();
const { fetchAllProducts } = require('../services/runchiseService');

// GET /api/catalog/products
router.get('/', async (req, res) => {
  try {
    const products = await fetchAllProducts();

    const result = products
      .filter((p) => p.status === 'activated')
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        sell_price: parseFloat(p.sell_price),
        image_url: p.image_url || null,
        category: p.product_category?.name ?? 'Lainnya',
        category_id: p.product_category?.id ?? null,
        status: p.status,
      }));

    res.json(result);
  } catch (error) {
    console.error('Product catalog fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;