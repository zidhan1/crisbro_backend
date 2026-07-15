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
  resendCustomerActivation,
  retryCustomerRunchiseSync,
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
const adminOnly = requireRole('admin');
const superAdminOnly = requireRole('admin');
const marketingOnly = requireRole('admin', 'marketing');

router.use(auth);

router.get('/users', superAdminOnly, listAdminUsers);
router.post('/users', superAdminOnly, createAdminUser);
router.put('/users/:id', superAdminOnly, updateAdminUser);
router.delete('/users/:id', superAdminOnly, deleteAdminUser);

router.get('/customers', marketingOnly, listAdminCustomers);
router.post('/customers', marketingOnly, createAdminCustomer);
router.put('/customers/:id', marketingOnly, updateAdminCustomer);
router.post('/customers/:id/activation', marketingOnly, resendCustomerActivation);
router.post('/customers/:id/runchise-sync', marketingOnly, retryCustomerRunchiseSync);
router.delete('/customers/:id', marketingOnly, deleteAdminCustomer);

router.get('/brands', marketingOnly, listAdminBrands);
router.get('/locations', marketingOnly, listAdminLocations);

router.get('/loyalty-summary', marketingOnly, getSummary);

router.get('/rewards', adminOnly, listRewards);
router.post('/rewards', adminOnly, createReward);
router.put('/rewards/:id', adminOnly, updateReward);

router.get('/catalog/menu-items', marketingOnly, listCatalogMenuItems);

router.get('/redeem-menu/categories', marketingOnly, listRedeemCategories);
router.post('/redeem-menu/categories', marketingOnly, createRedeemCategory);
router.put('/redeem-menu/categories/:id', marketingOnly, updateRedeemCategory);

router.get('/redeem-menu/items', marketingOnly, listRedeemItems);
router.post('/redeem-menu/items', marketingOnly, createRedeemItem);
router.put('/redeem-menu/items/:id', marketingOnly, updateRedeemItem);
router.delete('/redeem-menu/items/:id', marketingOnly, deleteRedeemItem);

router.get('/redemptions', adminOnly, listRedemptions);
router.put('/redemptions/:id/status', adminOnly, updateRedemptionStatus);

module.exports = router;
