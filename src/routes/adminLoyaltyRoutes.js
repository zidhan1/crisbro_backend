const express = require('express');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  resendActivationTargetLimiter,
  runchiseSyncTargetLimiter,
} = require('../lib/rateLimit');
const redeemAdminRoutes = require('./admin/redeemAdminRoutes');
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

router.use(redeemAdminRoutes);

module.exports = router;
