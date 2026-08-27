const express = require('express');
const router = express.Router();
const { getPromos } = require('../services/domain/promoService');
const { sharedCache } = require('../services/shared/cacheService');
const { respondWithServerError } = require('../lib/serverError');

const PROMO_CACHE_TTL_MS = Number(
  process.env.PROMO_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000,
);

// GET /api/promos
router.get(
  '/',
  sharedCache('PROMOS', PROMO_CACHE_TTL_MS),
  async (req, res) => {
    try {
      const { page, limit, status } = req.query;
      const params = {};

      if (page !== undefined) params.page = page;
      if (limit !== undefined) params.limit = limit;
      if (status !== undefined) params.status = status;

      const result = await getPromos(params);
      res.json(result);
    } catch (error) {
      // Handle validation errors from promo service
      if (error.message.includes('Status promo tidak valid')) {
        return res.status(400).json({ error: error.message });
      }
      respondWithServerError(res, error, 'promoRoutes');
    }
  },
);

module.exports = router;