const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/authMiddleware");
const { saleTransactionGenerateLimiter } = require("../lib/rateLimit");
const {
  generateSaleTransactions,
} = require("../controllers/saleTransaction.controller");

const adminOnly = requireRole("admin");

router.use(auth);

// Menarik sale transaction milik satu customer dari Runchise (paginated)
// lalu menyimpannya ke tabel SaleTransaction. Limiter diletakkan setelah
// cek role agar kuota per customer hanya dihabiskan request yang sah.
router.post(
  "/generate",
  adminOnly,
  saleTransactionGenerateLimiter,
  generateSaleTransactions,
);

module.exports = router;
