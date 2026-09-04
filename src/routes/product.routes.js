const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const {
  listLoyaltyProductsController,
  syncLoyaltyProductsController,
  deleteLoyaltyProductController,
} = require("../controllers/product.controller");

router.get("/", auth, listLoyaltyProductsController);

router.post(
  "/sync-loyalty-products",
  auth,
  requireRole("admin", "marketing"),
  syncLoyaltyProductsController,
);

router.delete(
  "/:loyalty_product_id",
  auth,
  requireRole("admin", "marketing"),
  deleteLoyaltyProductController,
);

module.exports = router;
