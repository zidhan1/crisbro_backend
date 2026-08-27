// Legacy Routes - Deprecated endpoints maintained for backward compatibility
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/authMiddleware");

// ===================== DEPRECATED ENDPOINTS =====================

// POST /redeem/:id - DEPRECATED
// Endpoint lama diganti dengan POST /api/redeem/:rewardId
// Dipertahankan untuk mencegah sukses palsu dari panggilan lama
router.post("/redeem/:id", auth, (req, res) => {
  return res.status(410).json({
    message:
      "Endpoint ini sudah tidak digunakan. Gunakan POST /api/redeem/:rewardId",
  });
});

// GET /rewards - MOVED
// Endpoint ini sekarang ada di /api/rewards-catalog
// Dipertahankan sebagai redirect untuk backward compatibility
router.get("/rewards", (req, res) => {
  return res.status(301).json({
    message: "Endpoint ini telah dipindahkan",
    new_endpoint: "/api/rewards-catalog",
    note: "Silakan gunakan endpoint baru untuk akses katalog reward",
  });
});

module.exports = router;
