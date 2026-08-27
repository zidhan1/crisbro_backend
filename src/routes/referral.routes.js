const express = require("express");
const router = express.Router();
const {
  auth,
  requireValidPhone,
  requireRole,
} = require("../middleware/authMiddleware");
const {
  generateReferralCodeController,
  renewReferralCodeController,
  validateReferralCodeController,
  listReferralCodeUsagesController,
} = require("../controllers/referral.controller");

router.get(
  "/usages",
  auth,
  requireRole("admin", "marketing"),
  listReferralCodeUsagesController,
);

// Generate Referral Code by User
router.post(
  "/generate",
  auth,
  requireRole("customer"),
  requireValidPhone,
  generateReferralCodeController,
);

// Renew an expired referral code owned by the authenticated customer.
router.patch(
  "/renew",
  auth,
  requireRole("customer"),
  requireValidPhone,
  renewReferralCodeController,
);

// Validate a newly registered customer's pending referral. The target user is
// selected explicitly by admin/marketing; the authenticated actor is not the target.
router.patch(
  "/validate/:user_id",
  auth,
  requireRole("admin", "marketing"),
  validateReferralCodeController,
);

module.exports = router;
