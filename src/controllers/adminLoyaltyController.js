const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');
const {
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
} = require('../constants/categoryMapping');
const { recordAdminActivity } = require('../services/adminActivityLogService');
const { createGetSummary } = require('./adminLoyalty/summaryController');
const {
  createRedeemAdminControllers,
} = require('./adminLoyalty/redeemAdminController');
const {
  toRedemptionTrend,
  toPublicRedemptionHistory,
} = require('../lib/loyaltySummaryProjection');
const { ValidationError } = require('../lib/validationError');
const {
  REDEEM_ITEM_SELECT,
  REDEEM_ITEM_AUDIT_INCLUDE,
} = require('./adminLoyalty/redeemItemProjection');
const {
  addRedeemPriceBreakdown,
  badRequest,
  buildRedeemItemOrderBy,
  getDefaultRedeemCategoryId,
  getDefaultRewardThreshold,
  getRedeemCatalogConfig,
  handleError,
  normalizeReportName,
  parseBoolean,
  parseDateBoundary,
  parseNonNegativeInt,
  parseScheduleBoundary,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
} = require('./adminLoyalty/adminLoyaltyShared');
const {
  listAdminUsers,
  listAdminActivityLogs,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
} = require('./adminLoyalty/adminUserController');
const {
  listAdminCustomers,
  createAdminCustomer,
  updateAdminCustomer,
  adjustCustomerLoyalty,
  resendCustomerActivation,
  retryCustomerRunchiseSync,
  deleteAdminCustomer,
  listAdminBrands,
  listAdminLocations,
} = require('./adminLoyalty/adminCustomerController');
const {
  listCustomerSalesTransactionReports,
  listCustomerSalesTransactionReportOutlets,
} = require('./adminLoyalty/salesTransactionReportController');
const {
  listRewards,
  createReward,
  updateReward,
} = require('./adminLoyalty/rewardsAdminController');

// L-7: file ini sekarang murni composition root. Logika tiap domain tinggal di
// modul `adminLoyalty/*`, sedangkan dua factory yang sudah ada sejak refactor
// sebelumnya (summary & redeem) tetap di-wire di sini persis seperti semula
// supaya bentuk dependency injection-nya tidak berubah.

const getSummary = createGetSummary({
  prisma,
  Prisma,
  parsePositiveInt,
  parseDateBoundary,
  toRedemptionTrend,
  toPublicRedemptionHistory,
  handleError,
  ValidationError,
});

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
} = createRedeemAdminControllers({
  prisma,
  Prisma,
  EXCLUDED_CRISBAR_CATEGORY_NAMES,
  getRedeemCatalogConfig,
  normalizeReportName,
  parseOptionalString,
  parseRequiredString,
  parsePositiveInt,
  parseBoolean,
  parseNonNegativeInt,
  parseScheduleBoundary,
  buildRedeemItemOrderBy,
  addRedeemPriceBreakdown,
  getDefaultRedeemCategoryId,
  recordAdminActivity,
  handleError,
  badRequest,
  getDefaultRewardThreshold,
  REDEEM_ITEM_SELECT,
  REDEEM_ITEM_AUDIT_INCLUDE,
});

module.exports = {
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
};
