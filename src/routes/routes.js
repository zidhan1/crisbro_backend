const express = require("express");
const customerRoutes = require("./customer.routes");
const userRoutes = require("./user.routes");
const saleTransactionRoutes = require("./saleTransaction.routes");
const authRoutes = require("./auth.routes");
const referralRoutes = require("./referral.routes");
const locationRoutes = require("./location.routes");
const subBrandRoutes = require("./subBrand.routes");
const webhookQontak = require("./qontak.routes");
const productRoutes = require("./product.routes");
const promoRoutes = require("./promo.routes");

const router = express.Router();

router.use(authRoutes);
router.use("/customers", customerRoutes);
router.use("/products", productRoutes);
router.use("/promos", promoRoutes);
router.use("/users", userRoutes);
router.use("/sale-transactions", saleTransactionRoutes);
router.use("/referral", referralRoutes);
router.use("/locations", locationRoutes);
router.use("/sub_brands", subBrandRoutes);
router.use("/webhook-qontak", webhookQontak);

module.exports = router;
