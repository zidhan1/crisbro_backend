const express = require('express');
const requireRole = require('../../middleware/requireRole');
const {
  validateRedeemItemCreate,
  validateRedeemItemId,
  validateRedeemItemList,
  validateRedeemItemUpdate,
} = require('../../middleware/adminLoyaltyValidation');
const {
  listCatalogMenuItems,
  listRedeemCategories,
  createRedeemCategory,
  updateRedeemCategory,
  listRedeemItems,
  createRedeemItem,
  updateRedeemItem,
  deleteRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
} = require('../../controllers/adminLoyaltyController');

const router = express.Router();
const adminOnly = requireRole('admin');
const adminOrMarketing = requireRole('admin', 'marketing');

router.get('/catalog/menu-items', adminOrMarketing, listCatalogMenuItems);

router.get('/redeem-menu/categories', adminOrMarketing, listRedeemCategories);
router.post(
  '/redeem-menu/categories',
  adminOrMarketing,
  createRedeemCategory,
);
router.put(
  '/redeem-menu/categories/:id',
  adminOrMarketing,
  updateRedeemCategory,
);

router.get(
  '/redeem-menu/items',
  adminOrMarketing,
  validateRedeemItemList,
  listRedeemItems,
);
router.post(
  '/redeem-menu/items',
  adminOrMarketing,
  validateRedeemItemCreate,
  createRedeemItem,
);
router.put(
  '/redeem-menu/items/:id',
  adminOrMarketing,
  validateRedeemItemUpdate,
  updateRedeemItem,
);
router.delete(
  '/redeem-menu/items/:id',
  adminOrMarketing,
  validateRedeemItemId,
  deleteRedeemItem,
);

router.get('/redemptions', adminOnly, listRedemptions);
router.put(
  '/redemptions/:id/status',
  adminOnly,
  updateRedemptionStatus,
);

module.exports = router;
