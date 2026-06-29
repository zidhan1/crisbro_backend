const express = require('express');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  getSummary,
  listRewards,
  createReward,
  updateReward,
  listCatalogMenuItems,
  listRedeemCategories,
  createRedeemCategory,
  updateRedeemCategory,
  listRedeemItems,
  createRedeemItem,
  updateRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
} = require('../controllers/adminLoyaltyController');

const router = express.Router();
const adminOnly = [auth, requireRole('admin', 'staff')];
const superAdminOnly = requireRole('admin');

router.use(...adminOnly);

router.get('/users', superAdminOnly, listAdminUsers);
router.post('/users', superAdminOnly, createAdminUser);
router.put('/users/:id', superAdminOnly, updateAdminUser);
router.delete('/users/:id', superAdminOnly, deleteAdminUser);

router.get('/loyalty-summary', getSummary);

router.get('/rewards', listRewards);
router.post('/rewards', createReward);
router.put('/rewards/:id', updateReward);

router.get('/catalog/menu-items', listCatalogMenuItems);

router.get('/redeem-menu/categories', listRedeemCategories);
router.post('/redeem-menu/categories', createRedeemCategory);
router.put('/redeem-menu/categories/:id', updateRedeemCategory);

router.get('/redeem-menu/items', listRedeemItems);
router.post('/redeem-menu/items', createRedeemItem);
router.put('/redeem-menu/items/:id', updateRedeemItem);

router.get('/redemptions', listRedemptions);
router.put('/redemptions/:id/status', updateRedemptionStatus);

module.exports = router;
