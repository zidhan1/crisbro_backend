const express = require('express');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  resendActivationTargetLimiter,
  runchiseSyncTargetLimiter,
} = require('../lib/rateLimit');
const {
  listAdminUsers,
  listAdminActivityLogs,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  listAdminCustomers,
  listCustomerSalesTransactionReports,
  listCustomerSalesTransactionReportOutlets,
  createAdminCustomer,
  updateAdminCustomer,
  adjustCustomerLoyalty,
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
const adminOrMarketing = requireRole('admin', 'marketing');

router.use(auth);

router.get('/activity-logs', adminOnly, listAdminActivityLogs);

router.get('/users', superAdminOnly, listAdminUsers);
router.post('/users', superAdminOnly, createAdminUser);
router.put('/users/:id', superAdminOnly, updateAdminUser);
router.delete('/users/:id', superAdminOnly, deleteAdminUser);

router.get('/customers', adminOrMarketing, listAdminCustomers);
router.get(
  '/customer-sales-transaction-reports',
  adminOrMarketing,
  listCustomerSalesTransactionReports,
);
// M-8: memindahkan daftar outlet filter ke endpoint terpisah agar tidak melakukan distinct scan berulang pada tabel besar setiap perubahan page/filter.
router.get(
  '/customer-sales-transaction-reports/outlets',
  adminOrMarketing,
  listCustomerSalesTransactionReportOutlets,
);
router.post('/customers', adminOrMarketing, createAdminCustomer);
router.put('/customers/:id', adminOrMarketing, updateAdminCustomer);
router.post(
  '/customers/:id/loyalty-adjustment',
  adminOnly,
  adjustCustomerLoyalty,
);
router.post(
  '/customers/:id/activation',
  adminOrMarketing,
  resendActivationTargetLimiter,
  resendCustomerActivation,
);
router.post(
  '/customers/:id/runchise-sync',
  adminOrMarketing,
  runchiseSyncTargetLimiter,
  retryCustomerRunchiseSync,
);
router.delete('/customers/:id', adminOrMarketing, deleteAdminCustomer);

router.get('/brands', adminOrMarketing, listAdminBrands);
router.get('/locations', adminOrMarketing, listAdminLocations);

router.get('/loyalty-summary', adminOrMarketing, getSummary);

router.get('/rewards', adminOnly, listRewards);
router.post('/rewards', adminOnly, createReward);
router.put('/rewards/:id', adminOnly, updateReward);

router.get('/catalog/menu-items', adminOrMarketing, listCatalogMenuItems);

router.get('/redeem-menu/categories', adminOrMarketing, listRedeemCategories);
router.post('/redeem-menu/categories', adminOrMarketing, createRedeemCategory);
router.put(
  '/redeem-menu/categories/:id',
  adminOrMarketing,
  updateRedeemCategory,
);

router.get('/redeem-menu/items', adminOrMarketing, listRedeemItems);
router.post('/redeem-menu/items', adminOrMarketing, createRedeemItem);
router.put('/redeem-menu/items/:id', adminOrMarketing, updateRedeemItem);
router.delete('/redeem-menu/items/:id', adminOrMarketing, deleteRedeemItem);

router.get('/redemptions', adminOnly, listRedemptions);
router.put('/redemptions/:id/status', adminOnly, updateRedemptionStatus);

module.exports = router;
