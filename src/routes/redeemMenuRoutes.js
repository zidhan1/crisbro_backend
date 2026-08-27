const express = require('express');
const router = express.Router();
const {
  getActiveRedeemMenuItems,
  formatRedeemMenuItemsForAPI,
} = require('../services/domain/redeemMenuService');
const { sharedCache } = require('../services/shared/cacheService');
const { respondWithServerError } = require('../lib/serverError');

// GET /api/catalog/redeem-menu
router.get(
  '/',
  sharedCache('REDEEM_MENU'),
  async (req, res) => {
    try {
      const { category_id } = req.query;
      const filters = {};

      if (category_id !== undefined) {
        filters.category_id = category_id;
      }

      const items = await getActiveRedeemMenuItems(filters);
      const result = formatRedeemMenuItemsForAPI(items);

      res.json(result);
    } catch (error) {
      respondWithServerError(res, error, 'redeemMenuRoutes');
    }
  },
);

module.exports = router;