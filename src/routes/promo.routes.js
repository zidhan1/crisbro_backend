const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const {
  createPromoController,
  listPromoController,
  showPromoController,
  updatePromoController,
  activatePromoController,
  deactivatePromoController,
  syncPromoController,
  generatePromoCodeController,
} = require("../controllers/promo.controller");

router.get("/", auth, requireRole("admin", "marketing"), listPromoController);
router.get(
  "/:promo_id",
  auth,
  requireRole("admin", "marketing"),
  showPromoController,
);
router.post("/sync/:runchise_id", auth, requireRole("admin", "marketing"), syncPromoController);
router.post(
  "/:promo_id/promo-codes/generate",
  auth,
  requireRole("admin", "marketing"),
  generatePromoCodeController,
);
router.post(
  "/",
  auth,
  requireRole("admin", "marketing"),
  createPromoController,
);
router.patch(
  "/:promo_id",
  auth,
  requireRole("admin", "marketing"),
  updatePromoController,
);
router.patch(
  "/:promo_id/activate",
  auth,
  requireRole("admin", "marketing"),
  activatePromoController,
);
router.patch(
  "/:promo_id/deactivate",
  auth,
  requireRole("admin", "marketing"),
  deactivatePromoController,
);

module.exports = router;
