const express = require("express");
const { auth } = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");
const {
  resendActivationTargetLimiter,
  reportOutletsLimiter,
  runchiseSyncTargetLimiter,
} = require("../lib/rateLimit");
// L-7: validasi skema dipasang seragam di seluruh rute admin loyalty, bukan
// hanya rute redeem. Middleware ini hanya memvalidasi bentuk request; aturan
// domain beserta pesannya tetap di controller.
const {
  validateActivityLogList,
  validateAdminUserCreate,
  validateAdminUserList,
  validateAdminUserUpdate,
  validateCustomerCreate,
  validateCustomerList,
  validateCustomerUpdate,
  validateIdParam,
  validateLoyaltySummary,
  validateRewardCreate,
  validateRewardList,
  validateRewardUpdate,
  validateSalesTransactionReportList,
} = require("../middleware/adminLoyaltyValidation");
const redeemAdminRoutes = require("./admin/redeemAdminRoutes");
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
  resendCustomerActivation,
  retryCustomerRunchiseSync,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
  getSummary,
  listRewards,
  createReward,
  updateReward,
} = require("../controllers/adminLoyaltyController");

const router = express.Router();
const adminOnly = requireRole("admin");
const superAdminOnly = requireRole("admin");
const adminOrMarketing = requireRole("admin", "marketing");

router.use(auth);

router.get(
  "/activity-logs",
  adminOnly,
  validateActivityLogList,
  listAdminActivityLogs,
);

router.get("/users", superAdminOnly, validateAdminUserList, listAdminUsers);
router.post("/users", superAdminOnly, validateAdminUserCreate, createAdminUser);
router.put(
  "/users/:id",
  superAdminOnly,
  validateAdminUserUpdate,
  updateAdminUser,
);
router.delete("/users/:id", superAdminOnly, validateIdParam, deleteAdminUser);

router.get(
  "/customers",
  adminOrMarketing,
  validateCustomerList,
  listAdminCustomers,
);
router.get(
  "/customer-sales-transaction-reports",
  adminOrMarketing,
  validateSalesTransactionReportList,
  listCustomerSalesTransactionReports,
);
// M-8: memindahkan daftar outlet filter ke endpoint terpisah agar tidak melakukan distinct scan berulang pada tabel besar setiap perubahan page/filter.
router.get(
  "/customer-sales-transaction-reports/outlets",
  adminOrMarketing,
  reportOutletsLimiter,
  listCustomerSalesTransactionReportOutlets,
);
router.post(
  "/customers",
  adminOrMarketing,
  validateCustomerCreate,
  createAdminCustomer,
);
router.put(
  "/customers/:id",
  adminOrMarketing,
  validateCustomerUpdate,
  updateAdminCustomer,
);
// Urutan limiter dipertahankan seperti semula (limiter tetap gerbang pertama
// setelah cek role); validasi param disisipkan sesudahnya agar kuota anti-spam
// per customer tetap dihitung persis seperti desain L-4.
router.post(
  "/customers/:id/activation",
  adminOrMarketing,
  resendActivationTargetLimiter,
  validateIdParam,
  resendCustomerActivation,
);
router.post(
  "/customers/:id/runchise-sync",
  adminOrMarketing,
  runchiseSyncTargetLimiter,
  validateIdParam,
  retryCustomerRunchiseSync,
);
// Penghapusan customer mencakup anonimisasi PII historis dan merupakan aksi
// privasi/destruktif; marketing tidak memiliki kewenangan ini.
router.delete(
  "/customers/:id",
  adminOnly,
  validateIdParam,
  deleteAdminCustomer,
);

router.get("/brands", adminOrMarketing, listAdminBrands);
router.get("/locations", adminOrMarketing, listAdminLocations);

router.get(
  "/loyalty-summary",
  adminOrMarketing,
  validateLoyaltySummary,
  getSummary,
);

router.get("/rewards", adminOnly, validateRewardList, listRewards);
router.post("/rewards", adminOnly, validateRewardCreate, createReward);
router.put("/rewards/:id", adminOnly, validateRewardUpdate, updateReward);

router.use(redeemAdminRoutes);

module.exports = router;
