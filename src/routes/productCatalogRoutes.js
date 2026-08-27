const express = require('express');
const router = express.Router();
const {
  getVisibleProducts,
  formatProductsForAPI,
  getProductCategories,
} = require('../services/domain/catalogService');
const { sharedCache } = require('../services/shared/cacheService');
const { respondWithServerError } = require('../lib/serverError');

const CATALOG_CACHE_TTL_MS = Number(
  process.env.CATALOG_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000,
);

// GET /api/catalog/products
router.get(
  '/',
  sharedCache('PRODUCTS', CATALOG_CACHE_TTL_MS),
  async (req, res) => {
    try {
      const { category_id } = req.query;
      const items = await getVisibleProducts({ category_id });

      const result = formatProductsForAPI(items);
      res.json(result);
    } catch (error) {
      respondWithServerError(res, error, 'productCatalogRoutes');
    }
  },
);

// GET /api/catalog/products/categories
router.get(
  '/categories',
  sharedCache('PRODUCT_CATEGORIES', CATALOG_CACHE_TTL_MS),
  async (req, res) => {
    try {
      const categories = await getProductCategories();
      res.json(categories);
    } catch (error) {
      respondWithServerError(res, error, 'productCatalogRoutes');
    }
  },
);

module.exports = router;