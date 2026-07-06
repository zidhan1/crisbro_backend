const express = require('express');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  listAdminCustomers,
  createAdminCustomer,
  updateAdminCustomer,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
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
  deleteRedeemItem,
  listRedemptions,
  updateRedemptionStatus,
} = require('../controllers/adminLoyaltyController');

const router = express.Router();
const adminStaffOnly = requireRole('admin', 'staff');
const superAdminOnly = requireRole('admin');
const marketingOnly = requireRole('admin', 'staff', 'marketing');

router.use(auth);

router.get('/users', superAdminOnly, listAdminUsers);
router.post('/users', superAdminOnly, createAdminUser);
router.put('/users/:id', superAdminOnly, updateAdminUser);
router.delete('/users/:id', superAdminOnly, deleteAdminUser);

router.get('/customers', adminStaffOnly, listAdminCustomers);
router.post('/customers', adminStaffOnly, createAdminCustomer);
router.put('/customers/:id', adminStaffOnly, updateAdminCustomer);
router.delete('/customers/:id', adminStaffOnly, deleteAdminCustomer);

router.get('/brands', adminStaffOnly, listAdminBrands);
router.get('/locations', adminStaffOnly, listAdminLocations);

router.get('/loyalty-summary', marketingOnly, getSummary);

router.get('/rewards', adminStaffOnly, listRewards);
router.post('/rewards', adminStaffOnly, createReward);
router.put('/rewards/:id', adminStaffOnly, updateReward);

router.get('/catalog/menu-items', marketingOnly, listCatalogMenuItems);

router.get('/redeem-menu/categories', marketingOnly, listRedeemCategories);
router.post('/redeem-menu/categories', marketingOnly, createRedeemCategory);
router.put('/redeem-menu/categories/:id', marketingOnly, updateRedeemCategory);

router.get('/redeem-menu/items', marketingOnly, listRedeemItems);
router.post('/redeem-menu/items', marketingOnly, createRedeemItem);
router.put('/redeem-menu/items/:id', marketingOnly, updateRedeemItem);
router.delete('/redeem-menu/items/:id', marketingOnly, deleteRedeemItem);

router.get('/redemptions', adminStaffOnly, listRedemptions);
router.put('/redemptions/:id/status', adminStaffOnly, updateRedemptionStatus);

module.exports = router;
